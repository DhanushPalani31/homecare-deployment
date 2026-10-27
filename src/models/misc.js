import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true }, // CONSULT_REQUEST, ADVICE_READY, VISIT_ASSIGNED, BROADCAST...
    title: String,
    body: String, // must not contain PHI beyond what the recipient is entitled to
    data: Schema.Types.Mixed,
    readAt: Date,
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);
export const Notification = mongoose.model('Notification', notificationSchema);

const auditLogSchema = new Schema({
  at: { type: Date, default: Date.now, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  actorRole: String,
  action: { type: String, required: true, index: true }, // e.g. USER_CREATE, PATIENT_VIEW, ADVICE_SIGN
  entity: { type: String, index: true },
  entityId: { type: String, index: true },
  ip: String,
  userAgent: String,
  requestId: String,
  changes: Schema.Types.Mixed, // {field: {from, to}} – PHI-bearing fields are masked by the caller
  meta: Schema.Types.Mixed,
});
// Append-only: block updates/deletes through the model.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditLogSchema.pre(op, function blockMutation() {
    throw new Error('Audit log is append-only');
  });
}
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

const invoiceSchema = new Schema(
  {
    invoiceNo: { type: String, unique: true, required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    periodStart: Date,
    periodEnd: Date,
    items: [
      {
        description: String,
        visitId: { type: Schema.Types.ObjectId, ref: 'Visit' },
        serviceId: { type: Schema.Types.ObjectId, ref: 'CareService' },
        quantity: { type: Number, default: 1 },
        unitPrice: Number,
        taxPercent: Number,
        amount: Number,
      },
    ],
    subtotal: Number,
    tax: Number,
    discount: { type: Number, default: 0 },
    total: Number,
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID', 'VOID'], default: 'DRAFT', index: true },
    payments: [{ amount: Number, method: String, reference: String, paidAt: Date, recordedBy: { type: Schema.Types.ObjectId, ref: 'User' } }],
    dueDate: Date,
    issuedAt: Date,
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const Invoice = mongoose.model('Invoice', invoiceSchema);

const fileObjectSchema = new Schema(
  {
    ownerType: { type: String, enum: ['PATIENT', 'USER'], required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit' },
    consultationId: { type: Schema.Types.ObjectId, ref: 'Consultation' },
    category: { type: String, enum: ['CLINICAL_PHOTO', 'LAB_REPORT', 'PRESCRIPTION', 'DISCHARGE_SUMMARY', 'ID_PROOF', 'CREDENTIAL', 'OTHER'], default: 'OTHER' },
    title: String,
    storageKey: { type: String, required: true, select: false },
    mimeType: String,
    sizeBytes: Number,
    sha256: String,
    consentConfirmed: Boolean,
    visibility: { type: String, enum: ['CLINICAL_TEAM', 'PATIENT_AND_FAMILY', 'ADMIN_ONLY'], default: 'CLINICAL_TEAM' },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: Date,
  },
  { timestamps: true },
);
export const FileObject = mongoose.model('FileObject', fileObjectSchema);

/** Monotonic counters for human-readable numbers (patient codes, invoice numbers). */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);
export async function nextSequence(name, prefix, pad = 6) {
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `${prefix}${String(c.seq).padStart(pad, '0')}`;
}

const settingSchema = new Schema(
  { key: { type: String, unique: true, required: true }, value: Schema.Types.Mixed, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' } },
  { timestamps: true },
);
export const Setting = mongoose.model('Setting', settingSchema);
