import { Router } from 'express';
import { z } from 'zod';
import {
  Assignment, CaregiverLink, CarePlan, Consultation, DoctorAdvice, FileObject, Invoice, Patient, User, Visit, nextSequence,
} from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, paging, validate } from '../middleware/common.js';
import {
  accessiblePatientIds, isClinical, isPatientSide, requirePatientSidePermission, resolvePatientAccess, shapePatient,
} from '../services/accessService.js';
import { audit, diff } from '../services/auditService.js';
import { ADVICE_STATUS, CAREGIVER_PERMISSIONS, ROLES } from '../utils/constants.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { hashPassword, passwordSchema } from './auth.js';
import { shapeVisit } from './visits.js';

const router = Router();

const contact = z.object({ name: z.string().max(100), relation: z.string().max(50).optional(), phone: z.string().max(20), isPrimary: z.boolean().optional() });
const allergy = z.object({ substance: z.string().max(100), reaction: z.string().max(200).optional(), severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'UNKNOWN']).optional() });
const medication = z.object({ name: z.string().max(120), dose: z.string().max(60).optional(), route: z.string().max(40).optional(), frequency: z.string().max(60).optional(), startedAt: z.coerce.date().optional(), prescribedBy: z.string().max(100).optional() });
const history = z.object({ condition: z.string().max(200), since: z.string().max(40).optional(), notes: z.string().max(1000).optional(), status: z.enum(['ACTIVE', 'RESOLVED']).optional() });

const patientBase = z.object({
  name: z.object({ first: z.string().min(1).max(80), last: z.string().max(80).optional() }),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.string().max(30).optional(),
  bloodGroup: z.string().max(5).optional(),
  phone: z.string().max(20).optional(),
  email: z.email().optional(),
  address: z
    .object({ line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(80), state: z.string().max(80).optional(), postalCode: z.string().max(12).optional(), landmark: z.string().max(200).optional(), geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional() })
    .optional(),
  emergencyContacts: z.array(contact).max(5).optional(),
  allergies: z.array(allergy).max(50).optional(),
  currentMedications: z.array(medication).max(100).optional(),
  medicalHistory: z.array(history).max(100).optional(),
  primaryDiagnosis: z.string().max(300).optional(),
  mobilityStatus: z.string().max(100).optional(),
  assignedDoctorId: objectId.optional(),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'DISCHARGED', 'DECEASED']).optional(),
});

/* ------------------------------------------------------------------ list / create */

router.get('/', validate({ query: paging.extend({ status: z.string().optional() }) }), async (req, res) => {
  const { page, limit, q, status } = req.query;
  const ids = await accessiblePatientIds(req.user);
  const filter = {};
  if (ids) filter._id = { $in: ids };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'name.first': rx }, { 'name.last': rx }, { patientCode: rx }, { phone: rx }];
  }
  const projection = req.user.role === ROLES.ADMIN ? {} : 'patientCode name dateOfBirth gender address.city address.line1 primaryDiagnosis status allergies';
  const [items, total] = await Promise.all([
    Patient.find(filter, projection).sort({ 'name.first': 1 }).skip((page - 1) * limit).limit(limit),
    Patient.countDocuments(filter),
  ]);
  res.json({ data: items, page, limit, total });
});

router.post(
  '/',
  requireRole(ROLES.ADMIN),
  validate({
    body: patientBase.extend({
      createLogin: z.object({ email: z.email().optional(), mobile: z.string().regex(/^\+?\d{8,15}$/).optional(), password: passwordSchema }).optional(),
      consents: z.array(z.object({ type: z.enum(['TREATMENT', 'TELECONSULTATION', 'CLINICAL_PHOTOS', 'DATA_SHARING_FAMILY', 'COMMUNICATIONS']), granted: z.boolean(), method: z.enum(['VERBAL', 'WRITTEN', 'IN_APP']) })).optional(),
    }),
  }),
  async (req, res) => {
    const { createLogin, consents = [], ...data } = req.body;
    if (data.assignedDoctorId) {
      const d = await User.exists({ _id: data.assignedDoctorId, role: ROLES.DOCTOR });
      if (!d) throw badRequest('assignedDoctorId is not a doctor');
    }
    let userId;
    if (createLogin) {
      if (!createLogin.email && !createLogin.mobile) throw badRequest('Login needs an email or mobile');
      const u = await User.create({
        role: ROLES.PATIENT,
        email: createLogin.email,
        mobile: createLogin.mobile,
        passwordHash: await hashPassword(createLogin.password),
        name: data.name,
        createdBy: req.user._id,
      });
      userId = u._id;
    }
    const patient = await Patient.create({
      ...data,
      userId,
      patientCode: await nextSequence('patient', 'HC-'),
      consents: consents.map((c) => ({ ...c, recordedBy: req.user._id })),
      createdBy: req.user._id,
    });
    await audit(req, 'PATIENT_CREATE', 'Patient', patient._id, { patientCode: { to: patient.patientCode } });
    res.status(201).json({ patient });
  },
);

/* ------------------------------------------------------------------ read / update */

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  await audit(req, 'PATIENT_VIEW', 'Patient', ctx.patient._id, undefined, { relation: ctx.relation });
  res.json({ patient: shapePatient(ctx.patient, ctx), access: { relation: ctx.relation, permissions: ctx.permissions } });
});

router.patch('/:id', validate({ params: idParam, body: patientBase.partial().strict() }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  const p = ctx.patient;
  let allowed;
  if (ctx.relation === 'ADMIN') allowed = Object.keys(req.body);
  else if (['ASSIGNED_NURSE', 'ASSIGNED_DOCTOR'].includes(ctx.relation)) allowed = ['allergies', 'currentMedications', 'medicalHistory', 'mobilityStatus'];
  else if (ctx.relation === 'SELF') allowed = ['phone', 'email', 'address', 'emergencyContacts'];
  else throw forbidden('You cannot edit this patient record');
  const illegal = Object.keys(req.body).filter((k) => !allowed.includes(k));
  if (illegal.length) throw forbidden(`You cannot change: ${illegal.join(', ')}`);
  const before = p.toObject();
  Object.assign(p, req.body);
  await p.save();
  const phi = ['allergies', 'currentMedications', 'medicalHistory', 'primaryDiagnosis', 'address', 'phone', 'email', 'dateOfBirth'];
  await audit(req, 'PATIENT_UPDATE', 'Patient', p._id, diff(before, req.body, phi));
  res.json({ patient: shapePatient(p, ctx) });
});

/** Everything a nurse needs on arrival: care plan, allergies, history, recent vitals, latest advice. */
router.get('/:id/clinical-summary', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (!isClinical(ctx)) throw forbidden();
  const pid = ctx.patient._id;
  const [carePlan, recentVisits, recentAdvice] = await Promise.all([
    CarePlan.findOne({ patientId: pid, status: 'ACTIVE' }).populate('services.serviceId', 'name'),
    Visit.find({ patientId: pid, status: 'COMPLETED' }).sort({ scheduledStart: -1 }).limit(5).select('scheduledStart assessment.vitals assessment.symptoms summary nurseId').populate('nurseId', 'name'),
    DoctorAdvice.find({ patientId: pid, status: { $ne: ADVICE_STATUS.DRAFT } }).sort({ signedAt: -1 }).limit(3).populate('doctorId', 'name'),
  ]);
  await audit(req, 'CLINICAL_SUMMARY_VIEW', 'Patient', pid);
  res.json({ patient: shapePatient(ctx.patient, ctx), carePlan, recentVisits, recentAdvice });
});

router.get('/:id/team', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  const nurses = await Assignment.find({ patientId: ctx.patient._id, active: true }).populate('nurseId', 'name mobile professional.qualifications');
  const doctor = ctx.patient.assignedDoctorId ? await User.findById(ctx.patient.assignedDoctorId).select('name professional.specializations') : null;
  res.json({
    nurses: nurses.map((a) => ({ assignmentId: a._id, isPrimary: a.isPrimary, since: a.startDate, nurse: a.nurseId })),
    doctor,
  });
});

/* ------------------------------------------------------------------ consents & privacy */

router.post(
  '/:id/consents',
  validate({ params: idParam, body: z.object({ type: z.enum(['TREATMENT', 'TELECONSULTATION', 'CLINICAL_PHOTOS', 'DATA_SHARING_FAMILY', 'COMMUNICATIONS']), granted: z.boolean(), method: z.enum(['VERBAL', 'WRITTEN', 'IN_APP']), note: z.string().max(300).optional() }) }),
  async (req, res) => {
    const ctx = await resolvePatientAccess(req.user, req.params.id);
    if (!['ADMIN', 'ASSIGNED_NURSE', 'SELF'].includes(ctx.relation)) throw forbidden('Only the patient, their nurse or an administrator can record consent');
    ctx.patient.consents.push({ ...req.body, recordedBy: req.user._id, recordedAt: new Date() });
    await ctx.patient.save();
    await audit(req, 'CONSENT_RECORD', 'Patient', ctx.patient._id, { [req.body.type]: { to: req.body.granted } });
    res.status(201).json({ consents: ctx.patient.consents });
  },
);

router.patch(
  '/:id/privacy',
  validate({ params: idParam, body: z.object({ shareSummariesWithCaregivers: z.boolean().optional(), allowCommunications: z.boolean().optional() }).strict() }),
  async (req, res) => {
    const ctx = await resolvePatientAccess(req.user, req.params.id);
    if (!['ADMIN', 'SELF'].includes(ctx.relation)) throw forbidden();
    ctx.patient.privacy = { ...(ctx.patient.privacy?.toObject?.() || {}), ...req.body };
    await ctx.patient.save();
    await audit(req, 'PRIVACY_UPDATE', 'Patient', ctx.patient._id, diff({}, req.body));
    res.json({ privacy: ctx.patient.privacy });
  },
);

/* ------------------------------------------------------------------ caregivers */

router.get('/:id/caregivers', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (!['ADMIN', 'SELF'].includes(ctx.relation)) throw forbidden();
  const links = await CaregiverLink.find({ patientId: ctx.patient._id }).populate('caregiverUserId', 'name email mobile').sort({ createdAt: -1 });
  res.json({ data: links });
});

router.post(
  '/:id/caregivers',
  validate({
    params: idParam,
    body: z.object({
      relation: z.string().max(40),
      permissions: z.array(z.enum(CAREGIVER_PERMISSIONS)).min(1),
      // Link an existing PATIENT-role account, or create one for the caregiver
      caregiverUserId: objectId.optional(),
      newAccount: z.object({ name: z.object({ first: z.string().min(1), last: z.string().optional() }), email: z.email().optional(), mobile: z.string().regex(/^\+?\d{8,15}$/).optional(), password: passwordSchema }).optional(),
    }),
  }),
  async (req, res) => {
    const ctx = await resolvePatientAccess(req.user, req.params.id);
    if (!['ADMIN', 'SELF'].includes(ctx.relation)) throw forbidden('Only the patient or an administrator can grant caregiver access');
    let caregiverId = req.body.caregiverUserId;
    if (caregiverId) {
      const u = await User.findById(caregiverId);
      if (!u || u.role !== ROLES.PATIENT) throw badRequest('Caregiver must be a patient/family account');
    } else if (req.body.newAccount) {
      if (ctx.relation !== 'ADMIN') throw forbidden('Only administrators can create caregiver accounts');
      const n = req.body.newAccount;
      if (!n.email && !n.mobile) throw badRequest('Email or mobile is required');
      const u = await User.create({ role: ROLES.PATIENT, name: n.name, email: n.email, mobile: n.mobile, passwordHash: await hashPassword(n.password), createdBy: req.user._id });
      caregiverId = u._id;
    } else throw badRequest('caregiverUserId or newAccount is required');

    if (String(caregiverId) === String(ctx.patient.userId)) throw badRequest('The patient cannot be their own caregiver');
    await CaregiverLink.updateMany({ patientId: ctx.patient._id, caregiverUserId: caregiverId, revokedAt: null }, { revokedAt: new Date(), revokedBy: req.user._id });
    const link = await CaregiverLink.create({ patientId: ctx.patient._id, caregiverUserId: caregiverId, relation: req.body.relation, permissions: req.body.permissions, grantedBy: req.user._id });
    await audit(req, 'CAREGIVER_GRANT', 'Patient', ctx.patient._id, { caregiver: { to: String(caregiverId) }, permissions: { to: req.body.permissions } });
    res.status(201).json({ link });
  },
);

router.delete('/:id/caregivers/:linkId', validate({ params: z.object({ id: objectId, linkId: objectId }) }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (!['ADMIN', 'SELF'].includes(ctx.relation)) throw forbidden();
  const link = await CaregiverLink.findOneAndUpdate(
    { _id: req.params.linkId, patientId: ctx.patient._id, revokedAt: null },
    { revokedAt: new Date(), revokedBy: req.user._id },
    { returnDocument: 'after' },
  );
  if (!link) throw notFound('Active caregiver link not found');
  await audit(req, 'CAREGIVER_REVOKE', 'Patient', ctx.patient._id, { caregiver: { from: String(link.caregiverUserId), to: null } });
  res.json({ link });
});

/* ------------------------------------------------------------------ patient-scoped collections */

router.get('/:id/visits', validate({ params: idParam, query: z.object({ upcoming: z.coerce.boolean().optional() }) }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (isPatientSide(ctx)) requirePatientSidePermission(ctx, 'VIEW_APPOINTMENTS');
  const filter = { patientId: ctx.patient._id };
  if (req.query.upcoming) filter.scheduledStart = { $gte: new Date() };
  const visits = await Visit.find(filter).sort({ scheduledStart: req.query.upcoming ? 1 : -1 }).limit(100).populate('nurseId', 'name').populate('serviceId', 'name');
  res.json({ data: visits.map((v) => shapeVisit(v, ctx)) });
});

router.get('/:id/care-plans', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  const filter = { patientId: ctx.patient._id };
  if (isPatientSide(ctx)) {
    requirePatientSidePermission(ctx, 'VIEW_CARE_PLAN');
    filter.visibleToPatient = true;
    filter.status = { $in: ['ACTIVE', 'COMPLETED'] };
  }
  res.json({ data: await CarePlan.find(filter).populate('services.serviceId', 'name').sort({ createdAt: -1 }) });
});

/**
 * Approved clinical summaries for patient/family: only doctor-approved plain-language
 * summaries and approved visit summaries — never nursing notes or raw advice.
 */
router.get('/:id/summaries', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (isPatientSide(ctx)) {
    requirePatientSidePermission(ctx, 'VIEW_SUMMARIES');
    if (ctx.relation === 'CAREGIVER' && ctx.patient.privacy?.shareSummariesWithCaregivers === false) {
      throw forbidden('The patient has chosen not to share summaries with caregivers');
    }
  }
  const [advice, visits] = await Promise.all([
    DoctorAdvice.find({ patientId: ctx.patient._id, patientSummaryApproved: true }).select('content.patientSummary content.followUp signedAt doctorId').populate('doctorId', 'name').sort({ signedAt: -1 }),
    Visit.find({ patientId: ctx.patient._id, status: 'COMPLETED', summaryApproved: true }).select('scheduledStart summary nurseId').populate('nurseId', 'name').sort({ scheduledStart: -1 }),
  ]);
  res.json({
    consultations: advice.map((a) => ({ id: a._id, date: a.signedAt, doctor: a.doctorId?.name, summary: a.content?.patientSummary, followUp: a.content?.followUp })),
    visits: visits.map((v) => ({ id: v._id, date: v.scheduledStart, nurse: v.nurseId?.name, summary: v.summary })),
  });
});

router.get('/:id/consultations', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (!isClinical(ctx)) throw forbidden();
  const data = await Consultation.find({ patientId: ctx.patient._id }).sort({ requestedAt: -1 }).limit(50).populate('nurseId doctorId', 'name');
  res.json({ data });
});

router.get('/:id/invoices', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  if (ctx.relation !== 'ADMIN') requirePatientSidePermission(ctx, 'VIEW_BILLING');
  if (isClinical(ctx) && ctx.relation !== 'ADMIN') throw forbidden();
  const filter = { patientId: ctx.patient._id };
  if (isPatientSide(ctx)) filter.status = { $ne: 'DRAFT' };
  res.json({ data: await Invoice.find(filter).sort({ createdAt: -1 }) });
});

router.get('/:id/files', validate({ params: idParam }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.params.id);
  const filter = { patientId: ctx.patient._id, deletedAt: null };
  if (isPatientSide(ctx)) {
    requirePatientSidePermission(ctx, 'VIEW_DOCUMENTS');
    filter.visibility = 'PATIENT_AND_FAMILY';
  } else if (ctx.relation !== 'ADMIN') filter.visibility = { $ne: 'ADMIN_ONLY' };
  res.json({ data: await FileObject.find(filter).sort({ createdAt: -1 }).populate('uploadedBy', 'name role') });
});

export default router;
