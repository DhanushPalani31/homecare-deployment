import mongoose from 'mongoose';
import { CONSULT_STATUS, URGENCY, ADVICE_STATUS } from '../utils/constants.js';

const { Schema } = mongoose;

const consultationSchema = new Schema(
  {
    consultationNo: { type: String, unique: true, required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit' },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', index: true }, // doctor currently routed / accepted
    requestedDoctorId: { type: Schema.Types.ObjectId, ref: 'User' }, // nurse's explicit choice, if any
    parentConsultationId: { type: Schema.Types.ObjectId, ref: 'Consultation' }, // follow-up chain
    reason: { type: String, required: true },
    urgency: { type: String, enum: Object.values(URGENCY), required: true },
    observationsSnapshot: {
      vitals: Schema.Types.Mixed,
      symptoms: [String],
      observations: String,
    },
    status: { type: String, enum: Object.values(CONSULT_STATUS), default: CONSULT_STATUS.REQUESTED, index: true },
    roomId: { type: String, required: true, unique: true, select: false }, // never sent to non-participants
    routing: [
      {
        doctorId: { type: Schema.Types.ObjectId, ref: 'User' },
        offeredAt: Date,
        outcome: { type: String, enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'NO_ANSWER', 'CANCELLED'] },
        respondedAt: Date,
        declineReason: String,
      },
    ],
    ringExpiresAt: Date,
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    startedAt: Date, // media connected
    endedAt: Date,
    durationSeconds: Number,
    audioOnly: { type: Boolean, default: false },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    failureReason: String,
    reconnects: { type: Number, default: 0 },
    adviceId: { type: Schema.Types.ObjectId, ref: 'DoctorAdvice' },
    consent: {
      obtained: Boolean,
      method: { type: String, enum: ['VERBAL', 'WRITTEN', 'IN_APP'] },
      recordedAt: Date,
      recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true },
);
// At most one open consultation per nurse+patient at a time (enforced in service + this partial index)
consultationSchema.index(
  { nurseId: 1, patientId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['REQUESTED', 'ACCEPTED', 'IN_CALL'] } }, name: 'one_open_consult' },
);

export const Consultation = mongoose.model('Consultation', consultationSchema);

const prescriptionItemSchema = new Schema(
  {
    medication: { type: String, required: true },
    strength: String,
    dose: String,
    route: String,
    frequency: String,
    durationDays: Number,
    instructions: String,
  },
  { _id: false },
);

const adviceContentSchema = new Schema(
  {
    clinicalAssessment: String,
    provisionalDiagnosis: String,
    advice: String,
    nursingInstructions: String,
    prescriptions: [prescriptionItemSchema],
    followUp: { required: Boolean, inHours: Number, instructions: String },
    escalation: { required: Boolean, instructions: String }, // e.g. transfer to hospital
    patientSummary: String, // plain-language text that may be shared with patient/family
  },
  { _id: false },
);

const doctorAdviceSchema = new Schema(
  {
    consultationId: { type: Schema.Types.ObjectId, ref: 'Consultation', required: true, unique: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    content: adviceContentSchema,
    status: { type: String, enum: Object.values(ADVICE_STATUS), default: ADVICE_STATUS.DRAFT },
    version: { type: Number, default: 1 },
    signedAt: Date,
    signatureHash: String, // sha256 of canonical content + doctor + time: tamper evidence
    amendments: [
      {
        version: Number,
        amendedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        amendedAt: Date,
        reason: String,
        previousContent: adviceContentSchema,
        previousSignatureHash: String,
      },
    ],
    acknowledgement: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, nurseActions: String },
    patientSummaryApproved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const DoctorAdvice = mongoose.model('DoctorAdvice', doctorAdviceSchema);
