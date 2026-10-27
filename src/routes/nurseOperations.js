import { Router } from 'express';
import { z } from 'zod';
import { LeaveRequest, Visit } from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, validate } from '../middleware/common.js';
import { audit } from '../services/auditService.js';
import { conflict, badRequest, notFound } from '../utils/errors.js';
import { ROLES } from '../utils/constants.js';

const router = Router();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');

function monthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, monthNumber - 1, 1));
  const to = new Date(Date.UTC(year, monthNumber, 1));
  return { from, to };
}

router.get(
  '/attendance',
  requireRole(ROLES.NURSE),
  validate({ query: z.object({ month: monthSchema.optional() }) }),
  async (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const { from, to } = monthRange(month);
    const visits = await Visit.find({ nurseId: req.user._id, scheduledStart: { $gte: from, $lt: to } })
      .sort({ scheduledStart: 1 })
      .populate('patientId', 'patientCode name')
      .populate('serviceId', 'name')
      .select('scheduledStart status checkIn checkOut patientId serviceId');
    res.json({
      month,
      totals: {
        scheduled: visits.length,
        attended: visits.filter((visit) => visit.checkIn?.at).length,
        checkedOut: visits.filter((visit) => visit.checkOut?.at).length,
      },
      data: visits,
    });
  },
);

router.get(
  '/leaves',
  requireRole(ROLES.NURSE),
  validate({ query: z.object({ month: monthSchema }) }),
  async (req, res) => {
    const { from, to } = monthRange(req.query.month);
    const data = await LeaveRequest.find({ nurseId: req.user._id, startDate: { $lt: to }, endDate: { $gte: from } })
      .sort({ startDate: -1 });
    res.json({ data });
  },
);

router.post(
  '/leaves',
  requireRole(ROLES.NURSE),
  validate({
    body: z.object({
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      type: z.enum(['ANNUAL', 'SICK', 'EMERGENCY', 'OTHER']),
      reason: z.string().trim().min(5).max(1000),
    }),
  }),
  async (req, res) => {
    const startDate = new Date(Date.UTC(req.body.startDate.getUTCFullYear(), req.body.startDate.getUTCMonth(), req.body.startDate.getUTCDate()));
    const endDate = new Date(Date.UTC(req.body.endDate.getUTCFullYear(), req.body.endDate.getUTCMonth(), req.body.endDate.getUTCDate(), 23, 59, 59, 999));
    if (endDate < startDate) throw badRequest('End date must be on or after start date');

    const overlap = await LeaveRequest.exists({
      nurseId: req.user._id,
      status: { $in: ['PENDING', 'APPROVED'] },
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    });
    if (overlap) throw conflict('You already have a pending or approved leave request for these dates', 'LEAVE_OVERLAP');

    const leave = await LeaveRequest.create({ ...req.body, nurseId: req.user._id, startDate, endDate });
    await audit(req, 'LEAVE_REQUEST', 'LeaveRequest', leave._id, undefined, { startDate, endDate, type: leave.type });
    res.status(201).json({ leave });
  },
);

router.post(
  '/leaves/:id/cancel',
  requireRole(ROLES.NURSE),
  validate({ params: idParam }),
  async (req, res) => {
    const leave = await LeaveRequest.findOne({ _id: req.params.id, nurseId: req.user._id });
    if (!leave) throw notFound('Leave request not found');
    if (leave.status !== 'PENDING') throw conflict('Only pending leave requests can be cancelled');
    leave.status = 'CANCELLED';
    await leave.save();
    await audit(req, 'LEAVE_CANCEL', 'LeaveRequest', leave._id);
    res.json({ leave });
  },
);

export default router;
