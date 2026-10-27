import { Router } from 'express';
import { z } from 'zod';
import { Assignment, User } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, paging, validate } from '../middleware/common.js';
import { audit, diff } from '../services/auditService.js';
import { isDoctorBusy } from '../services/consultationService.js';
import { isOnline } from '../services/realtime.js';
import { revokeAllSessions } from '../services/tokenService.js';
import { ACCOUNT_STATUS, ROLES, ROLE_LIST } from '../utils/constants.js';
import { badRequest, notFound } from '../utils/errors.js';
import { hashPassword, passwordSchema } from './auth.js';

const router = Router();

const professionalInput = z
  .object({
    registrationNumber: z.string().max(60).optional(),
    registrationCouncil: z.string().max(120).optional(),
    registrationValidUntil: z.coerce.date().optional(),
    qualifications: z.array(z.object({ title: z.string().max(120), institution: z.string().max(160).optional(), year: z.number().int().optional() })).max(20).optional(),
    specializations: z.array(z.string().max(80)).max(20).optional(),
    yearsOfExperience: z.number().int().min(0).max(70).optional(),
    languages: z.array(z.string().max(40)).max(10).optional(),
    verificationStatus: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED']).optional(),
    canPrescribe: z.boolean().optional(),
  })
  .optional();

const userInput = z.object({
  role: z.enum(ROLE_LIST),
  email: z.email().optional(),
  mobile: z.string().regex(/^\+?\d{8,15}$/, 'Mobile must be 8-15 digits').optional(),
  password: passwordSchema,
  name: z.object({ first: z.string().min(1).max(80), last: z.string().max(80).optional() }),
  gender: z.string().max(30).optional(),
  dateOfBirth: z.coerce.date().optional(),
  employeeId: z.string().max(40).optional(),
  professional: professionalInput,
  status: z.enum([ACCOUNT_STATUS.ACTIVE, ACCOUNT_STATUS.PENDING]).optional(),
});

/** Presentation for admin listings; online ≠ clinically available. */
async function adminView(u) {
  const o = u.toSafeJSON();
  o.online = isOnline(u._id);
  if (u.role === ROLES.DOCTOR) {
    o.inCall = await isDoctorBusy(u._id);
    o.routable = o.online && !o.inCall && u.availability?.acceptingConsultations && u.professional?.verificationStatus === 'VERIFIED';
  }
  if (u.role === ROLES.NURSE) o.activePatients = await Assignment.countDocuments({ nurseId: u._id, active: true });
  return o;
}

router.get(
  '/',
  requireRole(ROLES.ADMIN),
  validate({ query: paging.extend({ role: z.enum(ROLE_LIST).optional(), status: z.enum(Object.values(ACCOUNT_STATUS)).optional() }) }),
  async (req, res) => {
    const { page, limit, q, role, status } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ 'name.first': rx }, { 'name.last': rx }, { email: rx }, { mobile: rx }, { employeeId: rx }];
    }
    const [items, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(filter),
    ]);
    res.json({ data: await Promise.all(items.map(adminView)), page, limit, total });
  },
);

/** Doctors a nurse may pick for a consultation – exposes only availability, no PHI. */
router.get('/doctors/available', requireRole(ROLES.NURSE, ROLES.ADMIN), async (_req, res) => {
  const doctors = await User.find({ role: ROLES.DOCTOR, status: ACCOUNT_STATUS.ACTIVE, 'professional.verificationStatus': 'VERIFIED' }).select(
    'name professional.specializations professional.languages availability',
  );
  const data = [];
  for (const d of doctors) {
    const online = isOnline(d._id);
    const busy = await isDoctorBusy(d._id);
    data.push({
      _id: d._id,
      name: d.name,
      specializations: d.professional?.specializations || [],
      languages: d.professional?.languages || [],
      acceptingConsultations: Boolean(d.availability?.acceptingConsultations),
      online,
      busy,
      available: online && !busy && Boolean(d.availability?.acceptingConsultations),
    });
  }
  data.sort((a, b) => Number(b.available) - Number(a.available));
  res.json({ data });
});

router.post('/', requireRole(ROLES.ADMIN), validate({ body: userInput }), async (req, res) => {
  const { password, ...rest } = req.body;
  if (!rest.email && !rest.mobile) throw badRequest('Email or mobile is required');
  if (rest.professional?.canPrescribe && rest.role !== ROLES.DOCTOR) throw badRequest('Only doctors can prescribe');
  const user = await User.create({ ...rest, passwordHash: await hashPassword(password), createdBy: req.user._id });
  await audit(req, 'USER_CREATE', 'User', user._id, { role: { to: user.role }, email: { to: user.email } });
  res.status(201).json({ user: await adminView(user) });
});

router.get('/:id', requireRole(ROLES.ADMIN), validate({ params: idParam }), async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User not found');
  res.json({ user: await adminView(user) });
});

router.patch(
  '/:id',
  requireRole(ROLES.ADMIN),
  validate({ params: idParam, body: userInput.omit({ password: true, role: true, status: true }).partial().strict() }),
  async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');
    const before = user.toObject();
    const { professional, ...rest } = req.body;
    Object.assign(user, rest);
    if (professional) {
      if (professional.canPrescribe && user.role !== ROLES.DOCTOR) throw badRequest('Only doctors can prescribe');
      user.professional = { ...(user.professional?.toObject?.() || {}), ...professional };
    }
    await user.save();
    const changes = diff(before, { ...rest, ...(professional ? { professional } : {}) });
    await audit(req, 'USER_UPDATE', 'User', user._id, changes);
    // Identity changes invalidate existing tokens
    if (rest.email || rest.mobile) await revokeAllSessions(user._id, 'IDENTITY_CHANGED');
    res.json({ user: await adminView(user) });
  },
);

/** Activate / suspend / deactivate. Suspension and deactivation end every session immediately. */
router.post(
  '/:id/status',
  requireRole(ROLES.ADMIN),
  validate({ params: idParam, body: z.object({ status: z.enum(Object.values(ACCOUNT_STATUS)), reason: z.string().max(300).optional() }) }),
  async (req, res) => {
    if (String(req.user._id) === req.params.id) throw badRequest('You cannot change your own account status');
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');
    const from = user.status;
    user.status = req.body.status;
    user.statusReason = req.body.reason;
    if (req.body.status !== ACCOUNT_STATUS.ACTIVE) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      if (user.availability) user.availability.acceptingConsultations = false;
    }
    await user.save();
    if (req.body.status !== ACCOUNT_STATUS.ACTIVE) {
      await revokeAllSessions(user._id, `ACCOUNT_${req.body.status}`);
      // On deactivation of a nurse, end their assignments so patients surface for reassignment.
      if (user.role === ROLES.NURSE && req.body.status === ACCOUNT_STATUS.DEACTIVATED) {
        await Assignment.updateMany({ nurseId: user._id, active: true }, { active: false, endDate: new Date(), endedBy: req.user._id, reason: 'NURSE_DEACTIVATED' });
      }
    }
    await audit(req, 'USER_STATUS_CHANGE', 'User', user._id, { status: { from, to: user.status } }, { reason: req.body.reason });
    res.json({ user: await adminView(user) });
  },
);

/** Verify / reject an uploaded credential document. */
router.post(
  '/:id/documents/:docId/verify',
  requireRole(ROLES.ADMIN),
  validate({ params: z.object({ id: objectId, docId: objectId }), body: z.object({ status: z.enum(['VERIFIED', 'REJECTED']), note: z.string().max(300).optional() }) }),
  async (req, res) => {
    const user = await User.findById(req.params.id);
    const doc = user?.professional?.documents?.id(req.params.docId);
    if (!doc) throw notFound('Document not found');
    doc.status = req.body.status;
    doc.note = req.body.note;
    doc.verifiedBy = req.user._id;
    doc.verifiedAt = new Date();
    await user.save();
    await audit(req, 'CREDENTIAL_VERIFY', 'User', user._id, { [`document.${doc.kind}`]: { to: req.body.status } });
    res.json({ user: await adminView(user) });
  },
);

router.post('/:id/reset-password', requireRole(ROLES.ADMIN), validate({ params: idParam, body: z.object({ newPassword: passwordSchema }) }), async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User not found');
  user.passwordHash = await hashPassword(req.body.newPassword);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.passwordChangedAt = new Date();
  await user.save();
  await revokeAllSessions(user._id, 'ADMIN_PASSWORD_RESET');
  await audit(req, 'USER_PASSWORD_RESET_BY_ADMIN', 'User', user._id);
  res.json({ message: 'Password reset; user must sign in again' });
});

export default router;
