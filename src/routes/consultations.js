import { Router } from 'express';
import { z } from 'zod';
import { Consultation, DoctorAdvice, Patient, User } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, validate } from '../middleware/common.js';
import { audit } from '../services/auditService.js';
import {
  acceptConsultation, acknowledgeAdvice, amendAdvice, cancelConsultation, createConsultation, declineConsultation, endCall,
  getConsultationForUser, saveAdviceDraft, signAdvice,
} from '../services/consultationService.js';
import { ADVICE_STATUS, CONSULT_STATUS, ROLES, URGENCY } from '../utils/constants.js';
import { forbidden } from '../utils/errors.js';

const router = Router();

router.post(
  '/',
  requireRole(ROLES.NURSE),
  validate({
    body: z.object({
      patientId: objectId,
      visitId: objectId.optional(),
      doctorId: objectId.optional(),
      parentConsultationId: objectId.optional(),
      reason: z.string().trim().min(5).max(1000),
      urgency: z.enum(Object.values(URGENCY)),
      observations: z.string().max(3000).optional(),
      audioOnly: z.boolean().optional(),
      consent: z.object({ obtained: z.boolean(), method: z.enum(['VERBAL', 'WRITTEN', 'IN_APP']).optional() }).optional(),
    }),
  }),
  async (req, res) => {
    const c = await createConsultation(req.user, req.body);
    await audit(req, 'CONSULT_REQUEST', 'Consultation', c._id, undefined, { urgency: c.urgency, status: c.status });
    res.status(201).json({ consultation: c });
  },
);

router.get(
  '/',
  validate({
    query: z.object({
      status: z.string().optional(), // comma separated
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      patientId: objectId.optional(),
      doctorId: objectId.optional(),
      nurseId: objectId.optional(),
      pendingForMe: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  async (req, res) => {
    const { status, from, to, patientId, doctorId, nurseId, pendingForMe, page, limit } = req.query;
    const f = {};
    const uid = req.user._id;
    switch (req.user.role) {
      case ROLES.NURSE:
        f.nurseId = uid;
        break;
      case ROLES.DOCTOR:
        f.$or = pendingForMe
          ? [{ status: CONSULT_STATUS.REQUESTED, routing: { $elemMatch: { doctorId: uid, outcome: 'PENDING' } } }]
          : [{ doctorId: uid }, { 'routing.doctorId': uid }];
        break;
      case ROLES.ADMIN:
        if (doctorId) f.doctorId = doctorId;
        if (nurseId) f.nurseId = nurseId;
        break;
      default:
        throw forbidden();
    }
    if (status) f.status = { $in: status.split(',') };
    if (patientId) f.patientId = patientId;
    if (from || to) f.requestedAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [data, total] = await Promise.all([
      Consultation.find(f)
        .sort({ requestedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('patientId', 'patientCode name')
        .populate('nurseId', 'name')
        .populate('doctorId', 'name')
        .populate('adviceId', 'status signedAt acknowledgement.at'),
      Consultation.countDocuments(f),
    ]);
    res.json({ data, page, limit, total });
  },
);

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const c = await getConsultationForUser(req.user, req.params.id);
  // A doctor who was only offered (and did not accept) sees the request details while pending, not afterwards.
  const uid = req.user._id;
  if (req.user.role === ROLES.DOCTOR && !c.doctorId?.equals(uid)) throw forbidden('This consultation was handled by another doctor');
  const [patient, nurse, doctor, advice] = await Promise.all([
    Patient.findById(c.patientId).select('patientCode name dateOfBirth gender allergies currentMedications medicalHistory primaryDiagnosis'),
    User.findById(c.nurseId).select('name mobile employeeId'),
    c.doctorId ? User.findById(c.doctorId).select('name professional.specializations professional.registrationNumber') : null,
    DoctorAdvice.findOne({ consultationId: c._id }).populate('amendments.amendedBy', 'name'),
  ]);
  const view = c.toObject();
  delete view.roomId;
  // Nurse sees advice only once signed; drafts stay with the doctor.
  const showAdvice = advice && (req.user.role !== ROLES.NURSE || advice.status !== ADVICE_STATUS.DRAFT);
  let adviceOut = showAdvice ? advice.toObject() : null;
  // Administrators monitor workflow, not clinical content (minimum necessary).
  if (adviceOut && req.user.role === ROLES.ADMIN) {
    adviceOut = {
      _id: adviceOut._id, status: adviceOut.status, version: adviceOut.version, signedAt: adviceOut.signedAt, signatureHash: adviceOut.signatureHash,
      acknowledgement: adviceOut.acknowledgement ? { at: adviceOut.acknowledgement.at } : undefined,
      amendments: (adviceOut.amendments || []).map((a) => ({ version: a.version, amendedAt: a.amendedAt, reason: a.reason })),
    };
  }
  await audit(req, 'CONSULT_VIEW', 'Consultation', c._id);
  res.json({ consultation: view, patient, nurse, doctor, advice: adviceOut });
});

router.post('/:id/accept', requireRole(ROLES.DOCTOR), validate({ params: idParam }), async (req, res) => {
  const c = await acceptConsultation(req.user, req.params.id);
  await audit(req, 'CONSULT_ACCEPT', 'Consultation', c._id);
  res.json({ consultation: c });
});

router.post('/:id/decline', requireRole(ROLES.DOCTOR), validate({ params: idParam, body: z.object({ reason: z.string().max(300).optional() }) }), async (req, res) => {
  const c = await declineConsultation(req.user, req.params.id, req.body.reason);
  await audit(req, 'CONSULT_DECLINE', 'Consultation', req.params.id, undefined, { reason: req.body.reason });
  res.json({ consultation: c });
});

router.post('/:id/cancel', requireRole(ROLES.NURSE), validate({ params: idParam, body: z.object({ reason: z.string().max(300).optional() }) }), async (req, res) => {
  const c = await cancelConsultation(req.user, req.params.id, req.body.reason || 'CANCELLED_BY_NURSE');
  await audit(req, 'CONSULT_CANCEL', 'Consultation', c._id);
  res.json({ consultation: c });
});

/** REST fallback for ending a call (e.g. app killed mid-call and relaunched). */
router.post('/:id/end', validate({ params: idParam, body: z.object({ reason: z.string().max(100).optional(), failed: z.boolean().optional() }) }), async (req, res) => {
  const c = await endCall(req.user, req.params.id, { reason: req.body.reason || 'ENDED', failed: req.body.failed });
  await audit(req, 'CONSULT_END', 'Consultation', c._id, undefined, { status: c.status, durationSeconds: c.durationSeconds });
  res.json({ consultation: c });
});

/* ------------------------------------------------------------------ advice */

const adviceContent = z.object({
  clinicalAssessment: z.string().max(5000).optional(),
  provisionalDiagnosis: z.string().max(500).optional(),
  advice: z.string().max(5000).optional(),
  nursingInstructions: z.string().max(5000).optional(),
  prescriptions: z
    .array(z.object({ medication: z.string().min(1).max(120), strength: z.string().max(40).optional(), dose: z.string().max(60).optional(), route: z.string().max(40).optional(), frequency: z.string().max(60).optional(), durationDays: z.number().int().min(1).max(365).optional(), instructions: z.string().max(300).optional() }))
    .max(20)
    .optional(),
  followUp: z.object({ required: z.boolean(), inHours: z.number().int().min(1).max(24 * 90).optional(), instructions: z.string().max(1000).optional() }).optional(),
  escalation: z.object({ required: z.boolean(), instructions: z.string().max(1000).optional() }).optional(),
  patientSummary: z.string().max(3000).optional(),
});

router.put('/:id/advice', requireRole(ROLES.DOCTOR), validate({ params: idParam, body: adviceContent }), async (req, res) => {
  const advice = await saveAdviceDraft(req.user, req.params.id, req.body);
  await audit(req, 'ADVICE_DRAFT_SAVE', 'DoctorAdvice', advice._id);
  res.json({ advice });
});

router.post('/:id/advice/sign', requireRole(ROLES.DOCTOR), validate({ params: idParam }), async (req, res) => {
  const advice = await signAdvice(req.user, req.params.id);
  await audit(req, 'ADVICE_SIGN', 'DoctorAdvice', advice._id, undefined, { signatureHash: advice.signatureHash, version: advice.version });
  res.json({ advice });
});

router.post('/:id/advice/amend', requireRole(ROLES.DOCTOR), validate({ params: idParam, body: z.object({ reason: z.string().min(5).max(500), content: adviceContent }) }), async (req, res) => {
  const advice = await amendAdvice(req.user, req.params.id, req.body);
  await audit(req, 'ADVICE_AMEND', 'DoctorAdvice', advice._id, undefined, { reason: req.body.reason, version: advice.version });
  res.json({ advice });
});

router.post('/:id/advice/approve-summary', requireRole(ROLES.DOCTOR), validate({ params: idParam }), async (req, res) => {
  const c = await getConsultationForUser(req.user, req.params.id);
  const advice = await DoctorAdvice.findOne({ consultationId: c._id });
  if (!advice || !advice.doctorId.equals(req.user._id)) throw forbidden();
  if (advice.status === ADVICE_STATUS.DRAFT || !advice.content?.patientSummary) throw forbidden('Sign the advice with a patient summary first');
  advice.patientSummaryApproved = true;
  await advice.save();
  await audit(req, 'ADVICE_SUMMARY_APPROVE', 'DoctorAdvice', advice._id);
  res.json({ advice });
});

router.post('/:id/advice/acknowledge', requireRole(ROLES.NURSE), validate({ params: idParam, body: z.object({ nurseActions: z.string().max(3000).optional() }) }), async (req, res) => {
  const advice = await acknowledgeAdvice(req.user, req.params.id, req.body.nurseActions);
  await audit(req, 'ADVICE_ACKNOWLEDGE', 'DoctorAdvice', advice._id);
  res.json({ advice });
});

export default router;
