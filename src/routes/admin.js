import { Router } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import {
  AuditLog, Assignment, CaregiverLink, CareService, Consultation, Invoice, LeaveRequest, Notification, Patient, Setting, User, Visit, nextSequence,
} from '../models/index.js';
import { requireRole } from '../middleware/auth.js';
import { idParam, objectId, validate } from '../middleware/common.js';
import { audit } from '../services/auditService.js';
import { notify } from '../services/notificationService.js';
import { onlineUserIds } from '../services/realtime.js';
import { ACCOUNT_STATUS, CONSULT_STATUS, ROLES, VISIT_STATUS } from '../utils/constants.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

/* ============================================================== notifications (all roles) */

export const notificationsRouter = Router();

notificationsRouter.get('/', validate({ query: z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }), async (req, res) => {
  const f = { userId: req.user._id };
  if (req.query.unread) f.readAt = null;
  const [data, unread] = await Promise.all([
    Notification.find(f).sort({ createdAt: -1 }).limit(req.query.limit),
    Notification.countDocuments({ userId: req.user._id, readAt: null }),
  ]);
  res.json({ data, unread });
});
notificationsRouter.post('/read-all', async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, readAt: null }, { readAt: new Date() });
  res.status(204).end();
});
notificationsRouter.post('/:id/read', validate({ params: idParam }), async (req, res) => {
  const n = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { readAt: new Date() }, { returnDocument: 'after' });
  if (!n) throw notFound();
  res.json({ notification: n });
});
notificationsRouter.post(
  '/broadcast',
  requireRole(ROLES.ADMIN),
  validate({ body: z.object({ roles: z.array(z.enum(['NURSE', 'DOCTOR', 'PATIENT', 'ADMIN'])).optional(), userIds: z.array(objectId).max(500).optional(), title: z.string().min(2).max(100), body: z.string().min(2).max(500), push: z.boolean().default(true) }) }),
  async (req, res) => {
    const { roles, userIds, title, body, push } = req.body;
    if (!roles?.length && !userIds?.length) throw badRequest('Choose roles or users');
    const f = { status: ACCOUNT_STATUS.ACTIVE, $or: [] };
    if (roles?.length) f.$or.push({ role: { $in: roles } });
    if (userIds?.length) f.$or.push({ _id: { $in: userIds } });
    const users = await User.find(f).select('_id');
    for (const u of users) await notify(u._id, { type: 'BROADCAST', title, body, push });
    await audit(req, 'NOTIFICATION_BROADCAST', 'Notification', undefined, undefined, { recipients: users.length, roles });
    res.json({ sent: users.length });
  },
);

/* ============================================================== dashboards (role-aware) */

export const dashboardRouter = Router();

const dayBounds = (d = new Date()) => {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  return [s, e];
};

dashboardRouter.get('/', async (req, res) => {
  const [start, end] = dayBounds();
  const uid = req.user._id;
  switch (req.user.role) {
    case ROLES.ADMIN: {
      const online = new Set(onlineUserIds());
      const [nurses, doctors, patients, visitsToday, byStatus, openConsults, pendingVerification, overdueInvoices] = await Promise.all([
        User.find({ role: ROLES.NURSE, status: ACCOUNT_STATUS.ACTIVE }).select('_id'),
        User.find({ role: ROLES.DOCTOR, status: ACCOUNT_STATUS.ACTIVE }).select('_id availability'),
        Patient.countDocuments({ status: 'ACTIVE' }),
        Visit.countDocuments({ scheduledStart: { $gte: start, $lt: end } }),
        Visit.aggregate([{ $match: { scheduledStart: { $gte: start, $lt: end } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
        Consultation.find({ status: { $in: [CONSULT_STATUS.REQUESTED, CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL] } })
          .populate('patientId', 'patientCode').populate('nurseId doctorId', 'name').sort({ requestedAt: -1 }).limit(20),
        User.countDocuments({ role: { $in: [ROLES.NURSE, ROLES.DOCTOR] }, 'professional.verificationStatus': 'PENDING' }),
        Invoice.countDocuments({ status: { $in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { $lt: new Date() } }),
      ]);
      const unassigned = await Patient.countDocuments({ status: 'ACTIVE', _id: { $nin: await Assignment.distinct('patientId', { active: true }) } });
      return res.json({
        counts: {
          activeNurses: nurses.length,
          nursesOnline: nurses.filter((n) => online.has(String(n._id))).length,
          activeDoctors: doctors.length,
          doctorsOnline: doctors.filter((d) => online.has(String(d._id))).length,
          doctorsAccepting: doctors.filter((d) => online.has(String(d._id)) && d.availability?.acceptingConsultations).length,
          activePatients: patients,
          unassignedPatients: unassigned,
          visitsToday,
          pendingVerification,
          overdueInvoices,
        },
        visitsTodayByStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
        openConsultations: openConsults,
      });
    }
    case ROLES.NURSE: {
      const [today, inProgress, patients, awaitingAck] = await Promise.all([
        Visit.find({ nurseId: uid, scheduledStart: { $gte: start, $lt: end } }).sort({ scheduledStart: 1 }).select('-assessment').populate('patientId', 'patientCode name address').populate('serviceId', 'name'),
        Visit.findOne({ nurseId: uid, status: VISIT_STATUS.STARTED }).select('_id patientId').populate('patientId', 'name patientCode'),
        Assignment.countDocuments({ nurseId: uid, active: true }),
        Consultation.find({ nurseId: uid, status: CONSULT_STATUS.COMPLETED, adviceId: { $ne: null } }).populate({ path: 'adviceId', match: { 'acknowledgement.at': null, status: { $ne: 'DRAFT' } }, select: '_id' }).select('_id consultationNo patientId').populate('patientId', 'name'),
      ]);
      return res.json({ todayVisits: today, inProgress, assignedPatients: patients, adviceAwaitingAcknowledgement: awaitingAck.filter((c) => c.adviceId) });
    }
    case ROLES.DOCTOR: {
      const [pending, active, todayDone, unsigned] = await Promise.all([
        Consultation.find({ status: CONSULT_STATUS.REQUESTED, routing: { $elemMatch: { doctorId: uid, outcome: 'PENDING' } } }).populate('patientId', 'patientCode name').populate('nurseId', 'name'),
        Consultation.findOne({ doctorId: uid, status: { $in: [CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL] } }).populate('patientId', 'patientCode name'),
        Consultation.countDocuments({ doctorId: uid, status: CONSULT_STATUS.COMPLETED, endedAt: { $gte: start, $lt: end } }),
        Consultation.find({ doctorId: uid, status: CONSULT_STATUS.COMPLETED }).populate({ path: 'adviceId', select: 'status' }).select('_id consultationNo patientId adviceId endedAt').populate('patientId', 'name').sort({ endedAt: -1 }).limit(50),
      ]);
      return res.json({
        availability: req.user.availability,
        pendingRequests: pending,
        activeConsultation: active,
        completedToday: todayDone,
        notesToSign: unsigned.filter((c) => !c.adviceId || c.adviceId.status === 'DRAFT'),
      });
    }
    default: {
      const own = await Patient.find({ userId: uid }).select('_id patientCode name');
      const links = await CaregiverLink.find({ caregiverUserId: uid, revokedAt: null }).populate('patientId', 'patientCode name');
      return res.json({
        patients: [
          ...own.map((p) => ({ patient: p, relation: 'SELF', permissions: ['ALL'] })),
          ...links.filter((l) => l.patientId).map((l) => ({ patient: l.patientId, relation: 'CAREGIVER', permissions: l.permissions })),
        ],
      });
    }
  }
});

/* ============================================================== admin-only */

export const adminRouter = Router();
adminRouter.use(requireRole(ROLES.ADMIN));

/* ---------- billing */

adminRouter.get('/invoices', validate({ query: z.object({ status: z.string().optional(), patientId: objectId.optional() }) }), async (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.patientId) f.patientId = req.query.patientId;
  res.json({ data: await Invoice.find(f).populate('patientId', 'patientCode name').sort({ createdAt: -1 }).limit(300) });
});

/** Build a draft invoice from completed, unbilled visits in the period. */
adminRouter.post(
  '/invoices/generate',
  validate({ body: z.object({ patientId: objectId, from: z.coerce.date(), to: z.coerce.date(), discount: z.number().min(0).default(0), dueInDays: z.number().int().min(0).max(90).default(15) }) }),
  async (req, res) => {
    const { patientId, from, to, discount, dueInDays } = req.body;
    const visits = await Visit.find({ patientId, status: VISIT_STATUS.COMPLETED, billed: { $ne: true }, scheduledStart: { $gte: from, $lte: to } }).populate('serviceId');
    if (!visits.length) throw badRequest('No unbilled completed visits in this period');
    const round2 = (n) => Math.round(n * 100) / 100;
    const items = visits.map((v) => {
      const s = v.serviceId || { name: 'Home visit', price: 0, taxPercent: 0 };
      const amount = round2(s.price);
      return { description: `${s.name} – ${v.scheduledStart.toISOString().slice(0, 10)}`, visitId: v._id, serviceId: s._id, quantity: 1, unitPrice: s.price, taxPercent: s.taxPercent || 0, amount };
    });
    const subtotal = round2(items.reduce((t, i) => t + i.amount, 0));
    const tax = round2(items.reduce((t, i) => t + (i.amount * (i.taxPercent || 0)) / 100, 0));
    if (discount > subtotal + tax) throw badRequest('Discount exceeds invoice amount');
    const inv = await Invoice.create({
      invoiceNo: await nextSequence('invoice', `INV-${new Date().getFullYear()}-`),
      patientId, periodStart: from, periodEnd: to, items, subtotal, tax, discount, total: round2(subtotal + tax - discount),
      dueDate: new Date(Date.now() + dueInDays * 86400000), createdBy: req.user._id,
    });
    await Visit.updateMany({ _id: { $in: visits.map((v) => v._id) } }, { billed: true });
    await audit(req, 'INVOICE_GENERATE', 'Invoice', inv._id, { total: { to: inv.total } });
    res.status(201).json({ invoice: inv });
  },
);

adminRouter.post('/invoices/:id/issue', validate({ params: idParam }), async (req, res) => {
  const inv = await Invoice.findOneAndUpdate({ _id: req.params.id, status: 'DRAFT' }, { status: 'ISSUED', issuedAt: new Date() }, { returnDocument: 'after' });
  if (!inv) throw conflict('Only draft invoices can be issued');
  const p = await Patient.findById(inv.patientId).select('userId');
  if (p?.userId) notify(p.userId, { type: 'INVOICE_ISSUED', title: 'New invoice', body: `Invoice ${inv.invoiceNo} is available.`, data: { invoiceId: String(inv._id) } }).catch(() => {});
  await audit(req, 'INVOICE_ISSUE', 'Invoice', inv._id);
  res.json({ invoice: inv });
});

adminRouter.post(
  '/invoices/:id/payments',
  validate({ params: idParam, body: z.object({ amount: z.number().positive(), method: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'INSURANCE', 'OTHER']), reference: z.string().max(100).optional(), paidAt: z.coerce.date().optional() }) }),
  async (req, res) => {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) throw notFound();
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw conflict('Payments can only be recorded on issued invoices');
    const paid = inv.payments.reduce((t, p) => t + p.amount, 0);
    if (paid + req.body.amount > inv.total + 0.001) throw badRequest('Payment exceeds outstanding balance');
    inv.payments.push({ ...req.body, paidAt: req.body.paidAt || new Date(), recordedBy: req.user._id });
    inv.status = paid + req.body.amount >= inv.total - 0.001 ? 'PAID' : 'PARTIALLY_PAID';
    await inv.save();
    await audit(req, 'PAYMENT_RECORD', 'Invoice', inv._id, { status: { to: inv.status } }, { amount: req.body.amount, method: req.body.method });
    res.json({ invoice: inv });
  },
);

adminRouter.post('/invoices/:id/void', validate({ params: idParam, body: z.object({ reason: z.string().min(3).max(300) }) }), async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv || inv.status === 'PAID' || inv.status === 'VOID') throw conflict('This invoice cannot be voided');
  inv.status = 'VOID';
  inv.notes = `VOID: ${req.body.reason}`;
  await inv.save();
  await Visit.updateMany({ _id: { $in: inv.items.map((i) => i.visitId).filter(Boolean) } }, { billed: false });
  await audit(req, 'INVOICE_VOID', 'Invoice', inv._id, undefined, { reason: req.body.reason });
  res.json({ invoice: inv });
});

/* ---------- reports */

function periodRange(period, dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (period === 'daily') end.setDate(end.getDate() + 1);
  else if (period === 'weekly') {
    start.setDate(start.getDate() - start.getDay());
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  } else {
    start.setDate(1);
    end.setTime(start.getTime());
    end.setMonth(end.getMonth() + 1);
  }
  return [start, end];
}

adminRouter.get('/reports/summary', validate({ query: z.object({ period: z.enum(['daily', 'weekly', 'monthly']).default('daily'), date: z.string().optional() }) }), async (req, res) => {
  const [start, end] = periodRange(req.query.period, req.query.date);
  const range = { $gte: start, $lt: end };
  const [visits, consults, avgCall, revenue, perNurse] = await Promise.all([
    Visit.aggregate([{ $match: { scheduledStart: range } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Consultation.aggregate([{ $match: { requestedAt: range } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Consultation.aggregate([{ $match: { requestedAt: range, status: 'COMPLETED' } }, { $group: { _id: null, avg: { $avg: '$durationSeconds' }, avgAnswerMs: { $avg: { $subtract: ['$acceptedAt', '$requestedAt'] } } } }]),
    Invoice.aggregate([{ $match: { issuedAt: range, status: { $ne: 'VOID' } } }, { $group: { _id: null, billed: { $sum: '$total' } } }]),
    Visit.aggregate([
      { $match: { scheduledStart: range } },
      { $group: { _id: '$nurseId', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } }, missed: { $sum: { $cond: [{ $eq: ['$status', 'MISSED'] }, 1, 0] } } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'nurse' } },
      { $project: { total: 1, completed: 1, missed: 1, name: { $first: '$nurse.name' } } },
      { $sort: { total: -1 } },
    ]),
  ]);
  res.json({
    period: req.query.period, from: start, to: end,
    visitsByStatus: Object.fromEntries(visits.map((v) => [v._id, v.n])),
    consultationsByStatus: Object.fromEntries(consults.map((v) => [v._id, v.n])),
    avgCallSeconds: Math.round(avgCall[0]?.avg || 0),
    avgTimeToAnswerSeconds: Math.round((avgCall[0]?.avgAnswerMs || 0) / 1000),
    billed: revenue[0]?.billed || 0,
    nursePerformance: perNurse,
  });
});

const attendanceMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');
function selectedMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, monthNumber - 1, 1));
  return { from, to: new Date(Date.UTC(year, monthNumber, 1)) };
}

adminRouter.get(
  '/attendance',
  validate({ query: z.object({ month: attendanceMonth.optional(), nurseId: objectId.optional() }) }),
  async (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const { from, to } = selectedMonth(month);
    const filter = { scheduledStart: { $gte: from, $lt: to } };
    if (req.query.nurseId) filter.nurseId = req.query.nurseId;
    const visits = await Visit.find(filter)
      .sort({ scheduledStart: 1 })
      .limit(5000)
      .populate('patientId', 'patientCode name')
      .populate('nurseId', 'name')
      .select('scheduledStart scheduledEnd status checkIn.at checkOut.at patientId nurseId');
    const byNurse = new Map();
    for (const visit of visits) {
      const nurseId = String(visit.nurseId?._id || visit.nurseId);
      if (!byNurse.has(nurseId)) byNurse.set(nurseId, {
        nurseId,
        name: visit.nurseId?.name,
        scheduled: 0,
        attended: 0,
        checkedOut: 0,
        attendanceDays: new Set(),
      });
      const summary = byNurse.get(nurseId);
      summary.scheduled += 1;
      if (visit.checkIn?.at) {
        summary.attended += 1;
        summary.attendanceDays.add(new Date(visit.checkIn.at).toISOString().slice(0, 10));
      }
      if (visit.checkOut?.at) summary.checkedOut += 1;
    }
    const totals = [...byNurse.values()].map(({ attendanceDays, ...summary }) => ({ ...summary, attendanceDays: attendanceDays.size }));
    res.json({ month, totals, data: visits });
  },
);

adminRouter.get(
  '/leaves',
  validate({ query: z.object({ month: attendanceMonth, status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), nurseId: objectId.optional() }) }),
  async (req, res) => {
    const { from, to } = selectedMonth(req.query.month);
    const filter = { startDate: { $lt: to }, endDate: { $gte: from } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.nurseId) filter.nurseId = req.query.nurseId;
    const data = await LeaveRequest.find(filter).sort({ startDate: -1 }).limit(1000).populate('nurseId', 'name employeeId').populate('reviewedBy', 'name');
    res.json({ data });
  },
);

adminRouter.patch(
  '/leaves/:id',
  validate({ params: idParam, body: z.object({ status: z.enum(['APPROVED', 'REJECTED']), reviewNote: z.string().max(500).optional() }) }),
  async (req, res) => {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) throw notFound('Leave request not found');
    if (leave.status !== 'PENDING') throw conflict('Only pending leave requests can be reviewed');
    if (req.body.status === 'APPROVED') {
      const overlapping = await LeaveRequest.exists({
        _id: { $ne: leave._id },
        nurseId: leave.nurseId,
        status: 'APPROVED',
        startDate: { $lte: leave.endDate },
        endDate: { $gte: leave.startDate },
      });
      if (overlapping) throw conflict('This leave overlaps an already approved leave');
    }
    const updated = await LeaveRequest.findOneAndUpdate(
      { _id: leave._id, status: 'PENDING' },
      { $set: { status: req.body.status, reviewNote: req.body.reviewNote, reviewedBy: req.user._id, reviewedAt: new Date() } },
      { returnDocument: 'after' },
    ).populate('nurseId', 'name employeeId').populate('reviewedBy', 'name');
    if (!updated) throw conflict('Leave request has already been reviewed');
    await audit(req, `LEAVE_${req.body.status}`, 'LeaveRequest', updated._id, { status: { from: 'PENDING', to: updated.status } });
    res.json({ leave: updated });
  },
);

const fullName = (n) => [n?.first, n?.last].filter(Boolean).join(' ');
const EXPORTS = {
  visits: {
    columns: ['Visit ID', 'Scheduled', 'Patient code', 'Nurse', 'Service', 'Status', 'Check-in', 'Check-out'],
    load: (from, to) =>
      Visit.find({ scheduledStart: { $gte: from, $lte: to } }).populate('patientId', 'patientCode').populate('nurseId', 'name').populate('serviceId', 'name').sort({ scheduledStart: 1 }).lean(),
    row: (v) => [String(v._id), v.scheduledStart?.toISOString(), v.patientId?.patientCode, fullName(v.nurseId?.name), v.serviceId?.name, v.status, v.checkIn?.at?.toISOString(), v.checkOut?.at?.toISOString()],
  },
  leaves: {
    columns: ['Leave ID', 'Nurse', 'Start date', 'End date', 'Type', 'Reason', 'Status', 'Reviewed', 'Review note'],
    load: (from, to) =>
      LeaveRequest.find({ startDate: { $lte: to }, endDate: { $gte: from } }).populate('nurseId', 'name').sort({ startDate: 1 }).lean(),
    row: (l) => [String(l._id), fullName(l.nurseId?.name), l.startDate?.toISOString(), l.endDate?.toISOString(), l.type, l.reason, l.status, l.reviewedAt?.toISOString(), l.reviewNote],
  },
  consultations: {
    columns: ['Consultation', 'Requested', 'Patient code', 'Nurse', 'Doctor', 'Urgency', 'Status', 'Accepted', 'Started', 'Ended', 'Duration (s)', 'Failure reason'],
    load: (from, to) =>
      Consultation.find({ requestedAt: { $gte: from, $lte: to } }).populate('patientId', 'patientCode').populate('nurseId doctorId', 'name').sort({ requestedAt: 1 }).lean(),
    row: (c) => [c.consultationNo, c.requestedAt?.toISOString(), c.patientId?.patientCode, fullName(c.nurseId?.name), fullName(c.doctorId?.name), c.urgency, c.status, c.acceptedAt?.toISOString(), c.startedAt?.toISOString(), c.endedAt?.toISOString(), c.durationSeconds ?? '', c.failureReason ?? ''],
  },
  invoices: {
    columns: ['Invoice', 'Patient code', 'Issued', 'Status', 'Subtotal', 'Tax', 'Discount', 'Total', 'Paid'],
    load: (from, to) => Invoice.find({ createdAt: { $gte: from, $lte: to } }).populate('patientId', 'patientCode').sort({ createdAt: 1 }).lean(),
    row: (i) => [i.invoiceNo, i.patientId?.patientCode, i.issuedAt?.toISOString(), i.status, i.subtotal, i.tax, i.discount, i.total, i.payments.reduce((t, p) => t + p.amount, 0)],
  },
};

const csvCell = (v) => {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

adminRouter.get(
  '/reports/export',
  validate({ query: z.object({ type: z.enum(['visits', 'leaves', 'consultations', 'invoices']), format: z.enum(['csv', 'xlsx']).default('csv'), from: z.coerce.date(), to: z.coerce.date() }) }),
  async (req, res) => {
    const { type, format, from, to } = req.query;
    if ((to - from) / 86400000 > 366) throw badRequest('Export range is limited to one year');
    const def = EXPORTS[type];
    const rows = (await def.load(from, to)).map(def.row);
    const name = `${type}_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
    await audit(req, 'REPORT_EXPORT', 'Report', type, undefined, { format, rows: rows.length, from, to });
    if (format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
      return res.send([def.columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'));
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(type);
    ws.addRow(def.columns).font = { bold: true };
    rows.forEach((r) => ws.addRow(r.map((c) => (typeof c === 'string' && /^[=+\-@]/.test(c) ? `'${c}` : c))));
    ws.columns.forEach((c) => { c.width = 20; });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"` });
    await wb.xlsx.write(res);
    res.end();
  },
);

/* ---------- audit log */

adminRouter.get(
  '/audit',
  validate({ query: z.object({ actorId: objectId.optional(), action: z.string().max(60).optional(), entity: z.string().max(60).optional(), entityId: z.string().max(60).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }) }),
  async (req, res) => {
    const { actorId, action, entity, entityId, from, to, page, limit } = req.query;
    const f = {};
    if (actorId) f.actorId = actorId;
    if (action) f.action = action;
    if (entity) f.entity = entity;
    if (entityId) f.entityId = entityId;
    if (from || to) f.at = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [data, total] = await Promise.all([
      AuditLog.find(f).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).populate('actorId', 'name role'),
      AuditLog.countDocuments(f),
    ]);
    res.json({ data, page, limit, total });
  },
);

/* ---------- settings */

const SETTINGS_SCHEMA = z.object({
  organizationName: z.string().max(120).optional(),
  supportPhone: z.string().max(20).optional(),
  currency: z.string().length(3).optional(),
  missedVisitGraceHours: z.number().min(0).max(24).optional(),
  requireOtpForStaff: z.boolean().optional(),
});

adminRouter.get('/settings', async (_req, res) => {
  const rows = await Setting.find();
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});
adminRouter.put('/settings', validate({ body: SETTINGS_SCHEMA }), async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await Setting.findOneAndUpdate({ key }, { value, updatedBy: req.user._id }, { upsert: true });
  }
  await audit(req, 'SETTINGS_UPDATE', 'Setting', undefined, Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, { to: v }])));
  const rows = await Setting.find();
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

/* ---------- service pricing lookup used by billing UI */
adminRouter.get('/services/pricing', async (_req, res) => res.json({ data: await CareService.find().select('name price taxPercent currency active') }));
