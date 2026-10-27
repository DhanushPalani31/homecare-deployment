import { Router } from 'express';
import { z } from 'zod';
import { Assignment, CarePlan, CareService, LeaveRequest, Patient, Setting, Visit } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, validate } from '../middleware/common.js';
import { isPatientSide, requirePatientSidePermission, resolvePatientAccess } from '../services/accessService.js';
import { audit } from '../services/auditService.js';
import { notify } from '../services/notificationService.js';
import { ROLES, VISIT_STATUS } from '../utils/constants.js';
import { randomToken } from '../utils/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const router = Router();
const V = VISIT_STATUS;

/** Patient/family see schedule and approved summary only; no assessment or nursing notes. */
export function shapeVisit(visit, ctx) {
  const v = visit.toObject ? visit.toObject() : { ...visit };
  delete v.__v;
  if (ctx && isPatientSide(ctx)) {
    return {
      _id: v._id,
      scheduledStart: v.scheduledStart,
      scheduledEnd: v.scheduledEnd,
      status: v.status,
      nurse: v.nurseId?.name ? { name: v.nurseId.name } : undefined,
      service: v.serviceId?.name ? { name: v.serviceId.name } : undefined,
      checkInAt: v.checkIn?.at,
      checkOutAt: v.checkOut?.at,
      summary: v.summaryApproved ? v.summary : undefined,
    };
  }
  return v;
}

/** Load a visit the current user may act on as the assigned nurse. */
async function nurseVisit(req) {
  const visit = await Visit.findById(req.params.id);
  if (!visit) throw notFound('Visit not found');
  if (req.user.role !== ROLES.NURSE || !visit.nurseId.equals(req.user._id)) throw forbidden('This visit is not assigned to you');
  // Assignment may have ended since scheduling: re-check on every write.
  if (!(await Assignment.exists({ nurseId: req.user._id, patientId: visit.patientId, active: true }))) {
    throw forbidden('You are no longer assigned to this patient');
  }
  return visit;
}

const geo = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100),
});
const CHECK_IN_RADIUS_METERS = 150;

function verifyPatientLocation(patient, location) {
  const target = patient.address?.geo;
  if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
    throw new AppError(409, 'PATIENT_LOCATION_MISSING', 'Patient address coordinates are missing. Ask an administrator to add them before check-in or check-out.');
  }
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(location.lat - target.lat);
  const dLng = radians(location.lng - target.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(target.lat)) * Math.cos(radians(location.lat)) * Math.sin(dLng / 2) ** 2;
  const distanceMeters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (distanceMeters > CHECK_IN_RADIUS_METERS) {
    throw new AppError(403, 'OUTSIDE_PATIENT_LOCATION', `You must be within ${CHECK_IN_RADIUS_METERS} metres of the patient to check in or out.`);
  }
  return Math.round(distanceMeters);
}

/* ------------------------------------------------------------------ scheduling (admin) */

const scheduleBody = z.object({
  patientId: objectId,
  nurseId: objectId,
  serviceId: objectId.optional(),
  carePlanId: objectId.optional(),
  start: z.coerce.date(),
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  recurrence: z
    .object({
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1), // 0 = Sunday
      until: z.coerce.date(),
    })
    .optional(),
});

router.post('/', requireRole(ROLES.ADMIN), validate({ body: scheduleBody }), async (req, res) => {
  const { patientId, nurseId, serviceId, carePlanId, start, recurrence } = req.body;
  if (!(await Assignment.exists({ patientId, nurseId, active: true }))) throw badRequest('Assign the nurse to this patient before scheduling');
  const service = serviceId ? await CareService.findById(serviceId) : null;
  if (serviceId && !service) throw badRequest('Service not found');
  if (carePlanId && !(await CarePlan.exists({ _id: carePlanId, patientId }))) throw badRequest('Care plan does not belong to this patient');
  const minutes = req.body.durationMinutes || service?.defaultDurationMinutes || 60;

  const starts = [];
  if (recurrence) {
    if (recurrence.until <= start) throw badRequest('Recurrence end must be after start');
    const maxSpanDays = 180;
    const cursor = new Date(start);
    while (cursor <= recurrence.until && starts.length < 500) {
      if (recurrence.daysOfWeek.includes(cursor.getDay())) starts.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
      if ((cursor - start) / 86400000 > maxSpanDays) break;
    }
  } else starts.push(start);
  if (!starts.length) throw badRequest('Recurrence produced no visits');

  // Overlap check for the nurse
  for (const s of starts) {
    const e = new Date(s.getTime() + minutes * 60000);
    const clash = await Visit.exists({ nurseId, status: { $in: [V.SCHEDULED, V.STARTED] }, scheduledStart: { $lt: e }, scheduledEnd: { $gt: s } });
    if (clash) throw conflict(`Nurse already has a visit overlapping ${s.toISOString()}`, 'SCHEDULE_CONFLICT');
    if (await LeaveRequest.exists({ nurseId, status: 'APPROVED', startDate: { $lt: e }, endDate: { $gte: s } })) {
      throw conflict(`Nurse has approved leave during ${s.toISOString()}`, 'NURSE_ON_LEAVE');
    }
  }
  const seriesId = recurrence ? randomToken(9) : undefined;
  const visits = await Visit.insertMany(
    starts.map((s) => ({ patientId, nurseId, serviceId, carePlanId, seriesId, scheduledStart: s, scheduledEnd: new Date(s.getTime() + minutes * 60000), createdBy: req.user._id })),
  );
  await audit(req, 'VISIT_SCHEDULE', 'Visit', visits[0]._id, undefined, { count: visits.length, seriesId });
  notify(nurseId, { type: 'VISIT_ASSIGNED', title: 'New visit scheduled', body: `${visits.length} visit(s) added to your schedule`, data: { visitId: String(visits[0]._id) } }).catch(() => {});
  res.status(201).json({ data: visits, seriesId });
});

router.get(
  '/',
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      status: z.enum(Object.values(V)).optional(),
      nurseId: objectId.optional(),
      patientId: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  }),
  async (req, res) => {
    const { from, to, status, nurseId, patientId, limit } = req.query;
    const filter = {};
    if (req.user.role === ROLES.NURSE) filter.nurseId = req.user._id;
    else if (req.user.role === ROLES.ADMIN) {
      if (nurseId) filter.nurseId = nurseId;
    } else throw forbidden('Use the patient visits endpoint');
    if (patientId) filter.patientId = patientId;
    if (status) filter.status = status;
    if (from || to) filter.scheduledStart = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const data = await Visit.find(filter)
      .sort({ scheduledStart: 1 })
      .limit(limit)
      .select('-assessment.nursingNotes')
      .populate('patientId', 'patientCode name address phone')
      .populate('nurseId', 'name')
      .populate('serviceId', 'name');
    res.json({ data });
  },
);

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const visit = await Visit.findById(req.params.id).populate('nurseId', 'name').populate('serviceId', 'name defaultDurationMinutes').populate('carePlanId');
  if (!visit) throw notFound('Visit not found');
  const ctx = await resolvePatientAccess(req.user, visit.patientId);
  if (isPatientSide(ctx)) requirePatientSidePermission(ctx, 'VIEW_APPOINTMENTS');
  if (ctx.relation === 'ASSIGNED_NURSE' && !visit.nurseId._id.equals(req.user._id)) {
    // Co-assigned nurses may view but not edit; nursing notes stay with the author.
    const v = visit.toObject();
    if (v.assessment) delete v.assessment.nursingNotes;
    return res.json({ visit: v });
  }
  res.json({ visit: shapeVisit(visit, ctx) });
});

router.patch(
  '/:id',
  requireRole(ROLES.ADMIN),
  validate({ params: idParam, body: z.object({ start: z.coerce.date().optional(), durationMinutes: z.number().int().min(15).optional(), nurseId: objectId.optional() }).strict() }),
  async (req, res) => {
    const visit = await Visit.findById(req.params.id);
    if (!visit) throw notFound('Visit not found');
    if (visit.status !== V.SCHEDULED) throw conflict('Only scheduled visits can be rescheduled');
    const before = { scheduledStart: visit.scheduledStart, nurseId: visit.nurseId };
    if (req.body.nurseId) {
      if (!(await Assignment.exists({ patientId: visit.patientId, nurseId: req.body.nurseId, active: true }))) throw badRequest('Nurse is not assigned to this patient');
      visit.nurseId = req.body.nurseId;
    }
    const duration = req.body.durationMinutes || (visit.scheduledEnd - visit.scheduledStart) / 60000;
    if (req.body.start) visit.scheduledStart = req.body.start;
    visit.scheduledEnd = new Date(visit.scheduledStart.getTime() + duration * 60000);
    await visit.save();
    await audit(req, 'VISIT_RESCHEDULE', 'Visit', visit._id, { scheduledStart: { from: before.scheduledStart, to: visit.scheduledStart }, nurseId: { from: before.nurseId, to: visit.nurseId } });
    notify(visit.nurseId, { type: 'VISIT_UPDATED', title: 'Visit updated', body: 'A visit on your schedule changed.', data: { visitId: String(visit._id) } }).catch(() => {});
    res.json({ visit });
  },
);

router.post('/:id/cancel', validate({ params: idParam, body: z.object({ reason: z.string().min(3).max(300), wholeSeries: z.boolean().optional() }) }), async (req, res) => {
  const visit = await Visit.findById(req.params.id);
  if (!visit) throw notFound('Visit not found');
  if (req.user.role !== ROLES.ADMIN) throw forbidden('Only administrators can cancel visits');
  const filter = req.body.wholeSeries && visit.seriesId ? { seriesId: visit.seriesId, status: V.SCHEDULED, scheduledStart: { $gte: visit.scheduledStart } } : { _id: visit._id, status: V.SCHEDULED };
  const r = await Visit.updateMany(filter, { status: V.CANCELLED, cancellation: { reason: req.body.reason, by: req.user._id, at: new Date() } });
  if (!r.modifiedCount) throw conflict('Only scheduled visits can be cancelled');
  await audit(req, 'VISIT_CANCEL', 'Visit', visit._id, undefined, { count: r.modifiedCount, reason: req.body.reason });
  res.json({ cancelled: r.modifiedCount });
});

/* ------------------------------------------------------------------ nurse workflow */

router.post(
  '/:id/start',
  requireRole(ROLES.NURSE),
  validate({ params: idParam, body: z.object({ patientVerified: z.literal(true), verificationMethod: z.enum(['PHOTO_ID', 'NAME_DOB', 'FAMILY_CONFIRMED', 'KNOWN_PATIENT']), geo }) }),
  async (req, res) => {
    const visit = await nurseVisit(req);
    if (visit.status !== V.SCHEDULED) throw conflict(`Visit is already ${visit.status.toLowerCase()}`);
    const other = await Visit.exists({ nurseId: req.user._id, status: V.STARTED, _id: { $ne: visit._id } });
    if (other) throw conflict('Complete your current visit before starting another', 'VISIT_IN_PROGRESS');
    const patient = await Patient.findById(visit.patientId).select('address.geo');
    if (!patient) throw notFound('Patient not found');
    const distanceMeters = verifyPatientLocation(patient, req.body.geo);
    const now = new Date(); // server time is authoritative
    const updated = await Visit.findOneAndUpdate(
      { _id: visit._id, status: V.SCHEDULED },
      {
        status: V.STARTED,
        checkIn: { at: now, geo: req.body.geo },
        verification: { patientVerified: true, method: req.body.verificationMethod, verifiedAt: now },
        assessment: { isDraft: true, updatedAt: now, updatedBy: req.user._id },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw conflict('Visit state changed, refresh and try again');
    await audit(req, 'VISIT_START', 'Visit', visit._id, undefined, { method: req.body.verificationMethod, distanceMeters, locationAccuracy: req.body.geo.accuracy });
    res.json({ visit: updated });
  },
);

const vitals = z
  .object({
    systolic: z.number().min(40).max(300).optional(),
    diastolic: z.number().min(20).max(200).optional(),
    temperatureC: z.number().min(30).max(45).optional(),
    pulse: z.number().min(20).max(250).optional(),
    respiratoryRate: z.number().min(4).max(80).optional(),
    spo2: z.number().min(50).max(100).optional(),
    bloodGlucose: z.number().min(10).max(900).optional(),
    glucoseContext: z.enum(['FASTING', 'RANDOM', 'POST_PRANDIAL']).optional(),
    painScore: z.number().int().min(0).max(10).optional(),
    weightKg: z.number().min(1).max(400).optional(),
  })
  .refine((v) => (v.systolic === undefined) === (v.diastolic === undefined), 'Enter both systolic and diastolic')
  .refine((v) => v.systolic === undefined || v.systolic > v.diastolic, 'Systolic must exceed diastolic');

const assessmentBody = z.object({
  isDraft: z.boolean().default(true),
  vitals: vitals.optional(),
  symptoms: z.array(z.string().max(100)).max(30).optional(),
  observations: z.string().max(5000).optional(),
  consciousness: z.enum(['ALERT', 'VOICE', 'PAIN', 'UNRESPONSIVE']).optional(),
  nursingNotes: z.string().max(10000).optional(),
  activities: z.array(z.object({ name: z.string().max(100), done: z.boolean(), note: z.string().max(500).optional(), at: z.coerce.date().optional() })).max(50).optional(),
  medicationAdministration: z
    .array(
      z.object({
        medication: z.string().max(120),
        dose: z.string().max(60).optional(),
        route: z.string().max(40).optional(),
        scheduledTime: z.string().max(10).optional(),
        administeredAt: z.coerce.date().optional(),
        status: z.enum(['GIVEN', 'REFUSED', 'HELD', 'NOT_AVAILABLE']),
        reason: z.string().max(300).optional(),
      }).refine((m) => m.status === 'GIVEN' || m.reason, 'A reason is required when medication is not given'),
    )
    .max(50)
    .optional(),
});

/** Save draft or final assessment. Allowed only while the visit is in progress. */
router.put('/:id/assessment', requireRole(ROLES.NURSE), validate({ params: idParam, body: assessmentBody }), async (req, res) => {
  const visit = await nurseVisit(req);
  if (visit.status !== V.STARTED) throw conflict('Assessment can only be edited during an active visit');
  const now = new Date();
  const prev = visit.assessment?.toObject?.() || {};
  visit.assessment = {
    ...prev,
    ...req.body,
    vitals: req.body.vitals ? { ...req.body.vitals, recordedAt: now } : prev.vitals,
    updatedAt: now,
    updatedBy: req.user._id,
  };
  await visit.save();
  await audit(req, req.body.isDraft ? 'ASSESSMENT_DRAFT_SAVE' : 'ASSESSMENT_SAVE', 'Visit', visit._id, { fields: Object.keys(req.body) });
  res.json({ visit });
});

router.post(
  '/:id/complete',
  requireRole(ROLES.NURSE),
  validate({ params: idParam, body: z.object({ summary: z.string().min(10).max(3000), shareSummaryWithPatient: z.boolean().default(true), geo }) }),
  async (req, res) => {
    const visit = await nurseVisit(req);
    if (visit.status !== V.STARTED) throw conflict('Only an in-progress visit can be completed');
    if (!visit.assessment?.vitals && !visit.assessment?.observations) throw badRequest('Record vitals or observations before checking out');
    const patient = await Patient.findById(visit.patientId).select('address.geo');
    if (!patient) throw notFound('Patient not found');
    const distanceMeters = verifyPatientLocation(patient, req.body.geo);
    const now = new Date();
    visit.status = V.COMPLETED;
    visit.checkOut = { at: now, geo: req.body.geo };
    visit.summary = req.body.summary;
    visit.summaryApproved = req.body.shareSummaryWithPatient;
    visit.assessment.isDraft = false;
    await visit.save();
    await audit(req, 'VISIT_COMPLETE', 'Visit', visit._id, undefined, { minutes: Math.round((now - visit.checkIn.at) / 60000), distanceMeters, locationAccuracy: req.body.geo.accuracy });
    res.json({ visit });
  },
);

/** Housekeeping: scheduled visits past their end + grace (admin setting, default 2h) become MISSED. */
export async function markMissedVisits() {
  const setting = await Setting.findOne({ key: 'missedVisitGraceHours' });
  const graceHours = typeof setting?.value === 'number' ? setting.value : 2;
  const cutoff = new Date(Date.now() - graceHours * 3600_000);
  return Visit.updateMany({ status: V.SCHEDULED, scheduledEnd: { $lt: cutoff } }, { status: V.MISSED });
}

export default router;
