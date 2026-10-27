import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/common.js';
import { audit, diff } from '../services/auditService.js';
import { isOnline } from '../services/realtime.js';
import { ROLES } from '../utils/constants.js';
import { buildIceServers } from '../services/turnService.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

/**
 * Self-service profile edits are limited to non-identity fields.
 * Role, status, email/mobile, registration numbers and verification are admin-only.
 */
router.patch(
  '/',
  validate({
    body: z
      .object({
        name: z.object({ first: z.string().min(1).max(80), last: z.string().max(80).optional() }).optional(),
        gender: z.string().max(30).optional(),
        languages: z.array(z.string().max(40)).max(10).optional(),
        mfaEnabled: z.boolean().optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const before = { name: req.user.name, gender: req.user.gender, mfaEnabled: req.user.mfaEnabled };
    const { languages, ...rest } = req.body;
    Object.assign(req.user, rest);
    if (languages && req.user.professional) req.user.professional.languages = languages;
    await req.user.save();
    await audit(req, 'PROFILE_UPDATE', 'User', req.user._id, diff(before, rest));
    res.json({ user: req.user.toSafeJSON() });
  },
);

router.put(
  '/push-token',
  validate({ body: z.object({ token: z.string().min(10).max(4096), platform: z.enum(['ios', 'android']), deviceId: z.string().max(128) }) }),
  async (req, res) => {
    const { token, platform, deviceId } = req.body;
    // A device token belongs to exactly one user: remove it from anyone else (shared tablets).
    await User.updateMany({ 'pushTokens.token': token }, { $pull: { pushTokens: { token } } });
    await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { deviceId } } });
    await User.updateOne({ _id: req.user._id }, { $push: { pushTokens: { token, platform, deviceId, updatedAt: new Date() } } });
    res.status(204).end();
  },
);

router.put(
  '/availability',
  requireRole(ROLES.DOCTOR),
  validate({
    body: z.object({
      acceptingConsultations: z.boolean(),
      weekly: z
        .array(z.object({ day: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
        .max(21)
        .optional(),
      note: z.string().max(200).optional(),
    }),
  }),
  async (req, res) => {
    req.user.availability = { ...(req.user.availability?.toObject?.() || {}), ...req.body, updatedAt: new Date() };
    await req.user.save();
    await audit(req, 'AVAILABILITY_UPDATE', 'User', req.user._id, { acceptingConsultations: { to: req.body.acceptingConsultations } });
    res.json({ availability: req.user.availability, online: isOnline(req.user._id) });
  },
);

/** Short-lived ICE servers (STUN + TURN credentials) for clinical users only. */
router.get('/ice-servers', requireRole(ROLES.NURSE, ROLES.DOCTOR), (req, res) => {
  res.json(buildIceServers(req.user._id));
});

export default router;
