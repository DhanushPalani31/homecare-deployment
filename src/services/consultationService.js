import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Consultation, DoctorAdvice, Patient, User, Visit, nextSequence } from '../models/index.js';
import { ACCOUNT_STATUS, ADVICE_STATUS, CONSULT_OPEN, CONSULT_STATUS, ROLES, VISIT_STATUS } from '../utils/constants.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { resolvePatientAccess } from './accessService.js';
import { notify } from './notificationService.js';
import { callClosed, emitToRole, emitToUser, getIo, isOnline } from './realtime.js';

const S = CONSULT_STATUS;
const ringTimers = new Map(); // consultId -> timeout

/* ----------------------------------------------------------------------------- helpers */

const publicView = (c) => {
  const o = c.toObject ? c.toObject() : { ...c };
  delete o.roomId;
  delete o.__v;
  return o;
};

/** Minimum-necessary payload for the doctor's incoming request screen. */
async function incomingPayload(c) {
  const [patient, nurse] = await Promise.all([
    Patient.findById(c.patientId).select('patientCode name dateOfBirth gender allergies'),
    User.findById(c.nurseId).select('name employeeId'),
  ]);
  return {
    consultationId: String(c._id),
    consultationNo: c.consultationNo,
    urgency: c.urgency,
    reason: c.reason,
    observations: c.observationsSnapshot,
    ringExpiresAt: c.ringExpiresAt,
    isFollowUp: Boolean(c.parentConsultationId),
    patient: patient && {
      id: String(patient._id),
      patientCode: patient.patientCode,
      name: [patient.name.first, patient.name.last].filter(Boolean).join(' '),
      dateOfBirth: patient.dateOfBirth,
      gender: patient.gender,
      allergies: patient.allergies,
    },
    nurse: nurse && { id: String(nurse._id), name: [nurse.name.first, nurse.name.last].filter(Boolean).join(' '), employeeId: nurse.employeeId },
  };
}

function broadcastAdmin(c, event = 'admin:consultation-update') {
  emitToRole(ROLES.ADMIN, event, { consultationId: String(c._id), status: c.status, urgency: c.urgency, updatedAt: new Date() });
}

export async function isDoctorBusy(doctorId, exceptConsultId) {
  const q = { doctorId, status: { $in: [S.ACCEPTED, S.IN_CALL] } };
  if (exceptConsultId) q._id = { $ne: exceptConsultId };
  return Boolean(await Consultation.exists(q));
}

async function doctorIsRoutable(doctor) {
  return (
    doctor &&
    doctor.role === ROLES.DOCTOR &&
    doctor.status === ACCOUNT_STATUS.ACTIVE &&
    doctor.professional?.verificationStatus === 'VERIFIED' &&
    doctor.availability?.acceptingConsultations === true &&
    isOnline(doctor._id) &&
    !(await isDoctorBusy(doctor._id))
  );
}

/** Ordered candidate list: patient's assigned doctor first, then other available doctors. */
async function findCandidateDoctor(c, excludeIds) {
  const exclude = new Set(excludeIds.map(String));
  const patient = await Patient.findById(c.patientId).select('assignedDoctorId');
  const preferred = patient?.assignedDoctorId && !exclude.has(String(patient.assignedDoctorId))
    ? await User.findById(patient.assignedDoctorId)
    : null;
  if (await doctorIsRoutable(preferred)) return preferred;

  const pool = await User.find({
    role: ROLES.DOCTOR,
    status: ACCOUNT_STATUS.ACTIVE,
    'professional.verificationStatus': 'VERIFIED',
    'availability.acceptingConsultations': true,
    _id: { $nin: [...exclude] },
  }).select('name role status professional availability');
  for (const d of pool) {
    if (await doctorIsRoutable(d)) return d;
  }
  return null;
}

function scheduleRingTimeout(consultId, doctorId, ms) {
  clearRingTimer(consultId);
  const t = setTimeout(() => {
    ringTimers.delete(String(consultId));
    handleRingTimeout(consultId, doctorId).catch((err) => logger.error({ err }, 'ring timeout handler failed'));
  }, ms);
  t.unref?.();
  ringTimers.set(String(consultId), t);
}
function clearRingTimer(consultId) {
  const t = ringTimers.get(String(consultId));
  if (t) clearTimeout(t);
  ringTimers.delete(String(consultId));
}

async function offerToDoctor(c, doctor) {
  const ringMs = env.CONSULT_RING_TIMEOUT_SECONDS * 1000;
  const ringExpiresAt = new Date(Date.now() + ringMs);
  const updated = await Consultation.findOneAndUpdate(
    { _id: c._id, status: S.REQUESTED },
    {
      $set: { doctorId: doctor._id, ringExpiresAt },
      $push: { routing: { doctorId: doctor._id, offeredAt: new Date(), outcome: 'PENDING' } },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return null;
  const payload = await incomingPayload(updated);
  emitToUser(doctor._id, 'consultation:request', payload);
  notify(doctor._id, {
    type: 'CONSULT_REQUEST',
    title: `${updated.urgency === 'ROUTINE' ? '' : `${updated.urgency} · `}Consultation request`,
    body: 'A nurse is requesting your opinion. Open the app to respond.',
    data: { consultationId: String(updated._id) },
    highPriority: true,
  }).catch(() => {});
  emitToUser(updated.nurseId, 'consultation:ringing', { consultationId: String(updated._id), doctorName: doctor.name, ringExpiresAt });
  scheduleRingTimeout(updated._id, doctor._id, ringMs);
  broadcastAdmin(updated);
  return updated;
}

/** Route to the next doctor or close the request. */
async function escalateOrClose(consultId, finalStatus, reason) {
  const c = await Consultation.findById(consultId);
  if (!c || c.status !== S.REQUESTED) return c;
  const tried = c.routing.map((r) => r.doctorId);
  const explicit = Boolean(c.requestedDoctorId);
  if (!explicit && c.routing.length < env.CONSULT_MAX_ESCALATIONS) {
    const next = await findCandidateDoctor(c, tried);
    if (next) {
      emitToUser(c.nurseId, 'consultation:escalated', { consultationId: String(c._id), reason });
      return offerToDoctor(c, next);
    }
  }
  const closed = await Consultation.findOneAndUpdate(
    { _id: c._id, status: S.REQUESTED },
    { $set: { status: finalStatus, failureReason: reason, endedAt: new Date(), ringExpiresAt: null } },
    { returnDocument: 'after' },
  );
  if (closed) {
    const event = finalStatus === S.DECLINED ? 'consultation:declined' : 'consultation:expired';
    emitToUser(closed.nurseId, event, { consultationId: String(closed._id), reason });
    notify(closed.nurseId, {
      type: finalStatus === S.DECLINED ? 'CONSULT_DECLINED' : 'CONSULT_NO_ANSWER',
      title: finalStatus === S.DECLINED ? 'Consultation declined' : 'No doctor answered',
      body: 'You can retry, choose another doctor or follow your escalation protocol.',
      data: { consultationId: String(closed._id) },
    }).catch(() => {});
    broadcastAdmin(closed);
  }
  return closed;
}

export async function handleRingTimeout(consultId, doctorId) {
  const c = await Consultation.findOneAndUpdate(
    { _id: consultId, status: S.REQUESTED, doctorId, routing: { $elemMatch: { doctorId, outcome: 'PENDING' } } },
    { $set: { 'routing.$.outcome': 'NO_ANSWER', 'routing.$.respondedAt': new Date() } },
    { returnDocument: 'after' },
  );
  if (!c) return;
  emitToUser(doctorId, 'consultation:cancelled', { consultationId: String(c._id), reason: 'NO_ANSWER' });
  await escalateOrClose(c._id, S.EXPIRED, 'NO_ANSWER');
}

/** Periodic sweep so ring timeouts survive process restarts. */
export async function sweepExpiredRings() {
  const stale = await Consultation.find({ status: S.REQUESTED, ringExpiresAt: { $lt: new Date(Date.now() - 2000) } }).select('_id doctorId');
  for (const c of stale) await handleRingTimeout(c._id, c.doctorId);
}

/* ----------------------------------------------------------------------------- lifecycle */

export async function createConsultation(nurse, input) {
  if (nurse.role !== ROLES.NURSE) throw forbidden('Only nurses can request a doctor opinion');
  const ctx = await resolvePatientAccess(nurse, input.patientId);
  if (ctx.relation !== 'ASSIGNED_NURSE') throw forbidden('Patient is not assigned to you');
  const patient = ctx.patient;

  // Teleconsultation consent: either already on file, or captured now by the nurse.
  if (!patient.hasConsent('TELECONSULTATION')) {
    if (!input.consent?.obtained) {
      throw new AppError(422, 'CONSENT_REQUIRED', 'Patient consent for teleconsultation must be recorded before requesting');
    }
    patient.consents.push({ type: 'TELECONSULTATION', granted: true, method: input.consent.method || 'VERBAL', recordedBy: nurse._id });
    await patient.save();
  }

  let snapshot = {};
  if (input.visitId) {
    const visit = await Visit.findOne({ _id: input.visitId, nurseId: nurse._id, patientId: patient._id });
    if (!visit) throw badRequest('Visit not found for this patient');
    if (visit.status !== VISIT_STATUS.STARTED) throw badRequest('Start the visit before requesting a consultation');
    snapshot = {
      vitals: visit.assessment?.vitals,
      symptoms: visit.assessment?.symptoms,
      observations: visit.assessment?.observations,
    };
  }
  if (input.observations) snapshot.observations = input.observations;

  if (await Consultation.exists({ nurseId: nurse._id, patientId: patient._id, status: { $in: CONSULT_OPEN } })) {
    throw conflict('There is already an open consultation for this patient', 'CONSULT_ALREADY_OPEN');
  }

  let doctor = null;
  if (input.doctorId) {
    doctor = await User.findById(input.doctorId);
    if (!doctor || doctor.role !== ROLES.DOCTOR || doctor.status !== ACCOUNT_STATUS.ACTIVE) throw badRequest('Selected doctor not found');
    if (await isDoctorBusy(doctor._id)) throw conflict('The selected doctor is in another consultation', 'DOCTOR_BUSY');
    if (!(await doctorIsRoutable(doctor))) throw conflict('The selected doctor is not available right now', 'DOCTOR_UNAVAILABLE');
  }

  if (input.parentConsultationId) {
    const parent = await Consultation.findOne({ _id: input.parentConsultationId, patientId: patient._id });
    if (!parent) throw badRequest('Parent consultation not found for this patient');
  }

  let c;
  try {
    c = await Consultation.create({
      consultationNo: await nextSequence('consultation', 'CN-'),
      patientId: patient._id,
      nurseId: nurse._id,
      visitId: input.visitId,
      requestedDoctorId: doctor?._id,
      parentConsultationId: input.parentConsultationId,
      reason: input.reason,
      urgency: input.urgency,
      observationsSnapshot: snapshot,
      roomId: randomToken(24),
      audioOnly: Boolean(input.audioOnly),
      // method is absent when consent was already on file
      consent: { obtained: true, method: input.consent?.obtained ? input.consent.method || 'VERBAL' : undefined, recordedAt: new Date(), recordedBy: nurse._id },
    });
  } catch (err) {
    if (err?.code === 11000) throw conflict('There is already an open consultation for this patient', 'CONSULT_ALREADY_OPEN');
    throw err;
  }

  const target = doctor || (await findCandidateDoctor(c, []));
  if (!target) {
    c.status = S.EXPIRED;
    c.failureReason = 'NO_DOCTOR_AVAILABLE';
    c.endedAt = new Date();
    await c.save();
    broadcastAdmin(c);
    return publicView(c);
  }
  const offered = await offerToDoctor(c, target);
  return publicView(offered || c);
}

export async function acceptConsultation(doctor, consultId) {
  if (await isDoctorBusy(doctor._id, consultId)) throw conflict('Finish your current call before accepting another', 'DOCTOR_BUSY');
  const c = await Consultation.findOneAndUpdate(
    { _id: consultId, status: S.REQUESTED, doctorId: doctor._id, routing: { $elemMatch: { doctorId: doctor._id, outcome: 'PENDING' } } },
    { $set: { status: S.ACCEPTED, acceptedAt: new Date(), ringExpiresAt: null, 'routing.$.outcome': 'ACCEPTED', 'routing.$.respondedAt': new Date() } },
    { returnDocument: 'after' },
  );
  if (!c) {
    const existing = await Consultation.findById(consultId);
    if (!existing) throw notFound('Consultation not found');
    throw conflict(`This request is no longer available (${existing.status.toLowerCase()})`, 'CONSULT_NOT_AVAILABLE');
  }
  clearRingTimer(c._id);
  const payload = { consultationId: String(c._id), doctorId: String(doctor._id), doctorName: doctor.name, acceptedAt: c.acceptedAt };
  emitToUser(c.nurseId, 'consultation:accepted', payload);
  emitToUser(doctor._id, 'consultation:accepted', payload);
  broadcastAdmin(c);
  return publicView(c);
}

export async function declineConsultation(doctor, consultId, reason) {
  const c = await Consultation.findOneAndUpdate(
    { _id: consultId, status: S.REQUESTED, doctorId: doctor._id, routing: { $elemMatch: { doctorId: doctor._id, outcome: 'PENDING' } } },
    { $set: { 'routing.$.outcome': 'DECLINED', 'routing.$.respondedAt': new Date(), 'routing.$.declineReason': reason } },
    { returnDocument: 'after' },
  );
  if (!c) throw conflict('This request is no longer awaiting your response', 'CONSULT_NOT_AVAILABLE');
  clearRingTimer(c._id);
  const result = await escalateOrClose(c._id, S.DECLINED, 'DECLINED');
  return publicView(result || c);
}

export async function cancelConsultation(nurse, consultId, reason = 'CANCELLED_BY_NURSE') {
  const c = await Consultation.findOneAndUpdate(
    { _id: consultId, nurseId: nurse._id, status: { $in: [S.REQUESTED, S.ACCEPTED] } },
    { $set: { status: S.CANCELLED, failureReason: reason, endedAt: new Date(), ringExpiresAt: null, endedBy: nurse._id } },
    { returnDocument: 'after' },
  );
  if (!c) throw conflict('Only a request that has not connected yet can be cancelled', 'CONSULT_NOT_CANCELLABLE');
  clearRingTimer(c._id);
  await Consultation.updateOne({ _id: c._id, 'routing.outcome': 'PENDING' }, { $set: { 'routing.$.outcome': 'CANCELLED' } });
  if (c.doctorId) emitToUser(c.doctorId, 'consultation:cancelled', { consultationId: String(c._id), reason });
  getIo()?.to(`consult:${c._id}`).emit('call:end', { consultationId: String(c._id), reason });
  callClosed(c._id);
  broadcastAdmin(c);
  return publicView(c);
}

/** Called by signaling when ICE reaches connected for the first time. */
export async function markCallConnected(consultId) {
  const c = await Consultation.findOneAndUpdate(
    { _id: consultId, status: { $in: [S.ACCEPTED, S.IN_CALL] } },
    [{ $set: { status: S.IN_CALL, startedAt: { $ifNull: ['$startedAt', '$$NOW'] } } }],
    { returnDocument: 'after', updatePipeline: true },
  );
  if (c) broadcastAdmin(c);
  return c;
}

export async function endCall(user, consultId, { reason = 'ENDED', failed = false } = {}) {
  const c = await Consultation.findById(consultId).select('+roomId');
  if (!c) throw notFound('Consultation not found');
  const isParticipant = c.nurseId.equals(user._id) || c.doctorId?.equals(user._id);
  if (!isParticipant && user.role !== ROLES.ADMIN) throw forbidden();
  if (!CONSULT_OPEN.includes(c.status)) return publicView(c); // idempotent

  const now = new Date();
  let status;
  if (failed) status = S.FAILED;
  else if (c.status === S.IN_CALL) status = S.COMPLETED;
  else if (c.status === S.ACCEPTED) status = S.CANCELLED;
  else status = S.CANCELLED;

  const updated = await Consultation.findOneAndUpdate(
    { _id: c._id, status: c.status },
    {
      $set: {
        status,
        endedAt: now,
        endedBy: user._id,
        failureReason: status === S.COMPLETED ? undefined : reason,
        durationSeconds: c.startedAt ? Math.round((now - c.startedAt) / 1000) : 0,
        ringExpiresAt: null,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) return publicView(await Consultation.findById(consultId));
  clearRingTimer(c._id);
  getIo()?.to(`consult:${c._id}`).emit('call:end', { consultationId: String(c._id), reason, status, endedBy: String(user._id) });
  callClosed(c._id);
  broadcastAdmin(updated);
  return publicView(updated);
}

export async function recordReconnect(consultId) {
  await Consultation.updateOne({ _id: consultId }, { $inc: { reconnects: 1 } });
}

/** Load a consultation and assert the user is a participant (or admin). */
export async function getConsultationForUser(user, consultId, { withRoom = false } = {}) {
  const q = Consultation.findById(consultId);
  if (withRoom) q.select('+roomId');
  const c = await q;
  if (!c) throw notFound('Consultation not found');
  const uid = user._id;
  const allowed =
    user.role === ROLES.ADMIN ||
    c.nurseId.equals(uid) ||
    c.doctorId?.equals(uid) ||
    (user.role === ROLES.DOCTOR && c.routing.some((r) => r.doctorId?.equals(uid)));
  if (!allowed) throw forbidden('You are not a participant in this consultation');
  return c;
}

/* ----------------------------------------------------------------------------- advice */

const canonical = (content) => JSON.stringify(content, Object.keys(content || {}).sort());

function assertAdviceAuthor(c, doctor) {
  if (doctor.role !== ROLES.DOCTOR || !c.doctorId?.equals(doctor._id)) throw forbidden('Only the consulting doctor can document advice');
  if (![S.ACCEPTED, S.IN_CALL, S.COMPLETED].includes(c.status)) throw badRequest('Advice can only be documented on an accepted consultation');
}

function checkPrescribing(doctor, content) {
  if (content?.prescriptions?.length && !doctor.professional?.canPrescribe) {
    throw forbidden('Your account is not authorised to prescribe');
  }
}

export async function saveAdviceDraft(doctor, consultId, content) {
  const c = await getConsultationForUser(doctor, consultId);
  assertAdviceAuthor(c, doctor);
  checkPrescribing(doctor, content);
  let advice = await DoctorAdvice.findOne({ consultationId: c._id });
  if (advice && advice.status !== ADVICE_STATUS.DRAFT) {
    throw conflict('Advice is signed. Use the amendment workflow to change it.', 'ADVICE_SIGNED');
  }
  if (!advice) advice = new DoctorAdvice({ consultationId: c._id, patientId: c.patientId, doctorId: doctor._id });
  advice.content = content;
  await advice.save();
  if (!c.adviceId) await Consultation.updateOne({ _id: c._id }, { adviceId: advice._id });
  return advice;
}

export async function signAdvice(doctor, consultId) {
  const c = await getConsultationForUser(doctor, consultId);
  assertAdviceAuthor(c, doctor);
  const advice = await DoctorAdvice.findOne({ consultationId: c._id });
  if (!advice) throw badRequest('Save the advice before signing');
  if (advice.status !== ADVICE_STATUS.DRAFT) throw conflict('Advice already signed', 'ADVICE_SIGNED');
  if (!advice.content?.advice && !advice.content?.clinicalAssessment) throw badRequest('Assessment or advice is required to sign');
  advice.status = ADVICE_STATUS.SIGNED;
  advice.signedAt = new Date();
  advice.signatureHash = sha256(`${canonical(advice.content.toObject())}|${doctor._id}|${advice.signedAt.toISOString()}|v${advice.version}`);
  await advice.save();
  emitToUser(c.nurseId, 'advice:ready', { consultationId: String(c._id), adviceId: String(advice._id) });
  notify(c.nurseId, {
    type: 'ADVICE_READY',
    title: 'Doctor advice available',
    body: 'Advice for your consultation has been signed. Please review and acknowledge.',
    data: { consultationId: String(c._id) },
    highPriority: true,
  }).catch(() => {});
  return advice;
}

/** Controlled amendment: only the signing doctor, with a reason; prior version is preserved. */
export async function amendAdvice(doctor, consultId, { content, reason }) {
  const c = await getConsultationForUser(doctor, consultId);
  const advice = await DoctorAdvice.findOne({ consultationId: c._id });
  if (!advice) throw notFound('Advice not found');
  if (!advice.doctorId.equals(doctor._id)) throw forbidden("You cannot amend another doctor's finalized notes");
  if (advice.status === ADVICE_STATUS.DRAFT) throw badRequest('Draft advice can be edited directly');
  if (!reason || reason.trim().length < 5) throw badRequest('An amendment reason is required');
  checkPrescribing(doctor, content);
  advice.amendments.push({
    version: advice.version,
    amendedBy: doctor._id,
    amendedAt: new Date(),
    reason,
    previousContent: advice.content,
    previousSignatureHash: advice.signatureHash,
  });
  advice.version += 1;
  advice.content = content;
  advice.status = ADVICE_STATUS.AMENDED;
  advice.signedAt = new Date();
  advice.signatureHash = sha256(`${canonical(content)}|${doctor._id}|${advice.signedAt.toISOString()}|v${advice.version}`);
  advice.acknowledgement = undefined; // nurse must acknowledge the amended version
  advice.patientSummaryApproved = false;
  await advice.save();
  emitToUser(c.nurseId, 'advice:ready', { consultationId: String(c._id), adviceId: String(advice._id), amended: true });
  notify(c.nurseId, { type: 'ADVICE_AMENDED', title: 'Doctor advice amended', body: 'Please review the amended advice.', data: { consultationId: String(c._id) } }).catch(() => {});
  return advice;
}

export async function acknowledgeAdvice(nurse, consultId, nurseActions) {
  const c = await getConsultationForUser(nurse, consultId);
  if (!c.nurseId.equals(nurse._id)) throw forbidden('Only the requesting nurse can acknowledge');
  const advice = await DoctorAdvice.findOne({ consultationId: c._id });
  if (!advice || advice.status === ADVICE_STATUS.DRAFT) throw badRequest('Advice has not been signed yet');
  advice.acknowledgement = { by: nurse._id, at: new Date(), nurseActions };
  await advice.save();
  if (c.visitId && nurseActions) {
    await Visit.updateOne({ _id: c.visitId }, { $push: { adviceActions: { consultationId: c._id, action: nurseActions, at: new Date() } } });
  }
  if (c.doctorId) emitToUser(c.doctorId, 'advice:acknowledged', { consultationId: String(c._id) });
  return advice;
}
