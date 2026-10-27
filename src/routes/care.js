import { Router } from 'express';
import { z } from 'zod';
import { Assignment, CarePlan, CareService, Patient, ServiceCategory, User } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, validate } from '../middleware/common.js';
import { resolvePatientAccess } from '../services/accessService.js';
import { audit, diff } from '../services/auditService.js';
import { notify } from '../services/notificationService.js';
import { ACCOUNT_STATUS, ROLES } from '../utils/constants.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

const router = Router();
const admin = requireRole(ROLES.ADMIN);

/* ------------------------------------------------------------------ service catalogue */

router.get('/categories', async (_req, res) => res.json({ data: await ServiceCategory.find().sort({ name: 1 }) }));

router.post('/categories', admin, validate({ body: z.object({ name: z.string().min(2).max(80), description: z.string().max(300).optional() }) }), async (req, res) => {
  const c = await ServiceCategory.create(req.body);
  await audit(req, 'CATEGORY_CREATE', 'ServiceCategory', c._id, { name: { to: c.name } });
  res.status(201).json({ category: c });
});

router.patch('/categories/:id', admin, validate({ params: idParam, body: z.object({ name: z.string().min(2).max(80).optional(), description: z.string().max(300).optional(), active: z.boolean().optional() }) }), async (req, res) => {
  const c = await ServiceCategory.findById(req.params.id);
  if (!c) throw notFound();
  const before = c.toObject();
  Object.assign(c, req.body);
  await c.save();
  await audit(req, 'CATEGORY_UPDATE', 'ServiceCategory', c._id, diff(before, req.body));
  res.json({ category: c });
});

const serviceBody = z.object({
  categoryId: objectId,
  name: z.string().min(2).max(120),
  description: z.string().max(1000).optional(),
  defaultDurationMinutes: z.number().int().min(15).max(1440),
  price: z.number().min(0),
  currency: z.string().length(3).optional(),
  taxPercent: z.number().min(0).max(50).optional(),
  requiresNurseSkill: z.array(z.string().max(60)).optional(),
  active: z.boolean().optional(),
});

router.get('/services', async (req, res) => {
  const filter = req.user.role === ROLES.ADMIN ? {} : { active: true };
  res.json({ data: await CareService.find(filter).populate('categoryId', 'name').sort({ name: 1 }) });
});

router.post('/services', admin, validate({ body: serviceBody }), async (req, res) => {
  if (!(await ServiceCategory.exists({ _id: req.body.categoryId }))) throw badRequest('Category not found');
  const s = await CareService.create(req.body);
  await audit(req, 'SERVICE_CREATE', 'CareService', s._id, { name: { to: s.name }, price: { to: s.price } });
  res.status(201).json({ service: s });
});

router.patch('/services/:id', admin, validate({ params: idParam, body: serviceBody.partial() }), async (req, res) => {
  const s = await CareService.findById(req.params.id);
  if (!s) throw notFound();
  const before = s.toObject();
  Object.assign(s, req.body);
  await s.save();
  await audit(req, 'SERVICE_UPDATE', 'CareService', s._id, diff(before, req.body));
  res.json({ service: s });
});

/* ------------------------------------------------------------------ nurse assignments */

router.get('/assignments', admin, validate({ query: z.object({ patientId: objectId.optional(), nurseId: objectId.optional(), active: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const f = {};
  if (req.query.patientId) f.patientId = req.query.patientId;
  if (req.query.nurseId) f.nurseId = req.query.nurseId;
  if (req.query.active) f.active = req.query.active === 'true';
  res.json({ data: await Assignment.find(f).populate('patientId', 'patientCode name').populate('nurseId', 'name').sort({ createdAt: -1 }).limit(500) });
});

/** Assign, or reassign (ends the current primary assignment) a nurse to a patient. */
router.post(
  '/assignments',
  admin,
  validate({ body: z.object({ patientId: objectId, nurseId: objectId, isPrimary: z.boolean().default(true), reassign: z.boolean().default(false), reason: z.string().max(300).optional() }) }),
  async (req, res) => {
    const { patientId, nurseId, isPrimary, reassign, reason } = req.body;
    const [patient, nurse] = await Promise.all([Patient.findById(patientId), User.findById(nurseId)]);
    if (!patient) throw badRequest('Patient not found');
    if (!nurse || nurse.role !== ROLES.NURSE || nurse.status !== ACCOUNT_STATUS.ACTIVE) throw badRequest('Nurse must be an active nurse account');
    if (await Assignment.exists({ patientId, nurseId, active: true })) throw badRequest('Nurse is already assigned to this patient');
    if (reassign) {
      await Assignment.updateMany({ patientId, isPrimary: true, active: true }, { active: false, endDate: new Date(), endedBy: req.user._id, reason: reason || 'REASSIGNED' });
    }
    const a = await Assignment.create({ patientId, nurseId, isPrimary, assignedBy: req.user._id, reason });
    await audit(req, reassign ? 'NURSE_REASSIGN' : 'NURSE_ASSIGN', 'Patient', patientId, { nurse: { to: String(nurseId) } }, { reason });
    notify(nurseId, { type: 'PATIENT_ASSIGNED', title: 'New patient assigned', body: `Patient ${patient.patientCode} has been assigned to you.`, data: { patientId: String(patientId) } }).catch(() => {});
    res.status(201).json({ assignment: a });
  },
);

router.post('/assignments/:id/end', admin, validate({ params: idParam, body: z.object({ reason: z.string().max(300).optional() }) }), async (req, res) => {
  const a = await Assignment.findOneAndUpdate({ _id: req.params.id, active: true }, { active: false, endDate: new Date(), endedBy: req.user._id, reason: req.body.reason }, { returnDocument: 'after' });
  if (!a) throw notFound('Active assignment not found');
  await audit(req, 'NURSE_UNASSIGN', 'Patient', a.patientId, { nurse: { from: String(a.nurseId), to: null } });
  res.json({ assignment: a });
});

/* ------------------------------------------------------------------ care plans */

const carePlanBody = z.object({
  patientId: objectId,
  title: z.string().min(3).max(200),
  goals: z.array(z.object({ description: z.string().max(500), targetDate: z.coerce.date().optional(), achieved: z.boolean().optional() })).max(30).optional(),
  interventions: z.array(z.object({ description: z.string().max(500), frequency: z.string().max(100).optional() })).max(50).optional(),
  services: z.array(z.object({ serviceId: objectId, frequency: z.string().max(100).optional(), durationMinutes: z.number().int().optional() })).max(30).optional(),
  precautions: z.array(z.string().max(300)).max(30).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED']).optional(),
  visibleToPatient: z.boolean().optional(),
});

router.get('/care-plans', admin, validate({ query: z.object({ patientId: objectId.optional(), status: z.string().optional() }) }), async (req, res) => {
  const f = {};
  if (req.query.patientId) f.patientId = req.query.patientId;
  if (req.query.status) f.status = req.query.status;
  res.json({ data: await CarePlan.find(f).populate('patientId', 'patientCode name').sort({ updatedAt: -1 }).limit(200) });
});

router.post('/care-plans', validate({ body: carePlanBody }), async (req, res) => {
  const ctx = await resolvePatientAccess(req.user, req.body.patientId);
  if (!['ADMIN', 'ASSIGNED_DOCTOR'].includes(ctx.relation)) throw forbidden('Only administrators or the assigned doctor can create care plans');
  if (req.body.status === 'ACTIVE' || !req.body.status) {
    await CarePlan.updateMany({ patientId: req.body.patientId, status: 'ACTIVE' }, { status: 'COMPLETED', updatedBy: req.user._id });
  }
  const plan = await CarePlan.create({ ...req.body, createdBy: req.user._id, updatedBy: req.user._id });
  await audit(req, 'CAREPLAN_CREATE', 'CarePlan', plan._id, { title: { to: plan.title } });
  res.status(201).json({ carePlan: plan });
});

router.patch('/care-plans/:id', validate({ params: idParam, body: carePlanBody.omit({ patientId: true }).partial() }), async (req, res) => {
  const plan = await CarePlan.findById(req.params.id);
  if (!plan) throw notFound();
  const ctx = await resolvePatientAccess(req.user, plan.patientId);
  if (!['ADMIN', 'ASSIGNED_DOCTOR'].includes(ctx.relation)) throw forbidden();
  const before = plan.toObject();
  Object.assign(plan, req.body, { updatedBy: req.user._id });
  await plan.save();
  await audit(req, 'CAREPLAN_UPDATE', 'CarePlan', plan._id, diff(before, req.body, ['goals', 'interventions', 'precautions']));
  res.json({ carePlan: plan });
});

export default router;
