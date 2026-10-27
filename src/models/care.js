import mongoose from 'mongoose';
import { VISIT_STATUS } from '../utils/constants.js';

const { Schema } = mongoose;

const serviceCategorySchema = new Schema(
  { name: { type: String, required: true, unique: true }, description: String, active: { type: Boolean, default: true } },
  { timestamps: true },
);
export const ServiceCategory = mongoose.model('ServiceCategory', serviceCategorySchema);

const careServiceSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
    name: { type: String, required: true },
    description: String,
    defaultDurationMinutes: { type: Number, default: 60 },
    price: { type: Number, required: true, min: 0 }, // in minor units? kept as decimal currency amount
    currency: { type: String, default: 'INR' },
    taxPercent: { type: Number, default: 0 },
    requiresNurseSkill: [String],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const CareService = mongoose.model('CareService', careServiceSchema);

const carePlanSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    title: { type: String, required: true },
    goals: [{ description: String, targetDate: Date, achieved: { type: Boolean, default: false } }],
    interventions: [{ description: String, frequency: String }],
    services: [{ serviceId: { type: Schema.Types.ObjectId, ref: 'CareService' }, frequency: String, durationMinutes: Number }],
    precautions: [String],
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED'], default: 'ACTIVE' },
    visibleToPatient: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const CarePlan = mongoose.model('CarePlan', carePlanSchema);

const vitalsSchema = new Schema(
  {
    systolic: { type: Number, min: 40, max: 300 },
    diastolic: { type: Number, min: 20, max: 200 },
    temperatureC: { type: Number, min: 30, max: 45 },
    pulse: { type: Number, min: 20, max: 250 },
    respiratoryRate: { type: Number, min: 4, max: 80 },
    spo2: { type: Number, min: 50, max: 100 },
    bloodGlucose: { type: Number, min: 10, max: 900 }, // mg/dL
    glucoseContext: { type: String, enum: ['FASTING', 'RANDOM', 'POST_PRANDIAL'] },
    painScore: { type: Number, min: 0, max: 10 },
    weightKg: Number,
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const assessmentSchema = new Schema(
  {
    isDraft: { type: Boolean, default: true },
    vitals: vitalsSchema,
    symptoms: [String],
    observations: String,
    consciousness: { type: String, enum: ['ALERT', 'VOICE', 'PAIN', 'UNRESPONSIVE'] },
    nursingNotes: String, // internal: never shown to patient/family
    activities: [{ name: String, done: Boolean, note: String, at: Date }],
    medicationAdministration: [
      {
        medication: String,
        dose: String,
        route: String,
        scheduledTime: String,
        administeredAt: Date,
        status: { type: String, enum: ['GIVEN', 'REFUSED', 'HELD', 'NOT_AVAILABLE'] },
        reason: String,
      },
    ],
    updatedAt: Date,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const visitSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'CareService' },
    carePlanId: { type: Schema.Types.ObjectId, ref: 'CarePlan' },
    seriesId: { type: String, index: true }, // shared by visits generated from one recurrence rule
    scheduledStart: { type: Date, required: true, index: true },
    scheduledEnd: { type: Date, required: true },
    status: { type: String, enum: Object.values(VISIT_STATUS), default: VISIT_STATUS.SCHEDULED, index: true },
    verification: { patientVerified: Boolean, method: String, verifiedAt: Date },
    checkIn: { at: Date, geo: { lat: Number, lng: Number, accuracy: Number } },
    checkOut: { at: Date, geo: { lat: Number, lng: Number, accuracy: Number } },
    assessment: assessmentSchema,
    adviceActions: [{ consultationId: { type: Schema.Types.ObjectId, ref: 'Consultation' }, action: String, at: Date }],
    summary: String, // patient-facing visit summary written at checkout
    summaryApproved: { type: Boolean, default: false },
    cancellation: { reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date },
    billed: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
visitSchema.index({ nurseId: 1, scheduledStart: 1 });

export const Visit = mongoose.model('Visit', visitSchema);
