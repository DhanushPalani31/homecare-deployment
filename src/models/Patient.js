import mongoose from 'mongoose';
import { CAREGIVER_PERMISSIONS } from '../utils/constants.js';

const { Schema } = mongoose;

const patientSchema = new Schema(
  {
    patientCode: { type: String, unique: true, required: true }, // human-friendly identifier, e.g. HC-000123
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true }, // patient's own login, optional
    name: { first: { type: String, required: true }, last: String },
    dateOfBirth: Date,
    gender: String,
    bloodGroup: String,
    phone: String,
    email: String,
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      landmark: String,
      geo: { lat: Number, lng: Number },
    },
    emergencyContacts: [{ name: String, relation: String, phone: String, isPrimary: Boolean }],
    allergies: [{ substance: String, reaction: String, severity: { type: String, enum: ['MILD', 'MODERATE', 'SEVERE', 'UNKNOWN'] } }],
    currentMedications: [{ name: String, dose: String, route: String, frequency: String, startedAt: Date, prescribedBy: String }],
    medicalHistory: [{ condition: String, since: String, notes: String, status: { type: String, enum: ['ACTIVE', 'RESOLVED'], default: 'ACTIVE' } }],
    primaryDiagnosis: String,
    mobilityStatus: String,
    assignedDoctorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    consents: [
      {
        type: { type: String, enum: ['TREATMENT', 'TELECONSULTATION', 'CLINICAL_PHOTOS', 'DATA_SHARING_FAMILY', 'COMMUNICATIONS'] },
        granted: Boolean,
        recordedAt: { type: Date, default: Date.now },
        recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        method: { type: String, enum: ['VERBAL', 'WRITTEN', 'IN_APP'] },
        note: String,
      },
    ],
    privacy: {
      shareSummariesWithCaregivers: { type: Boolean, default: true },
      allowCommunications: { type: Boolean, default: true },
    },
    status: { type: String, enum: ['ACTIVE', 'ON_HOLD', 'DISCHARGED', 'DECEASED'], default: 'ACTIVE', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

patientSchema.index({ 'name.first': 'text', 'name.last': 'text', patientCode: 'text' });

/** Latest decision for a consent type wins. */
patientSchema.methods.hasConsent = function hasConsent(type) {
  const entries = (this.consents || []).filter((c) => c.type === type);
  if (!entries.length) return false;
  return entries.sort((a, b) => b.recordedAt - a.recordedAt)[0].granted === true;
};

export const Patient = mongoose.model('Patient', patientSchema);

const caregiverLinkSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    caregiverUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relation: String,
    permissions: [{ type: String, enum: CAREGIVER_PERMISSIONS }],
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    grantedAt: { type: Date, default: Date.now },
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
caregiverLinkSchema.index({ patientId: 1, caregiverUserId: 1 });

export const CaregiverLink = mongoose.model('CaregiverLink', caregiverLinkSchema);

const assignmentSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isPrimary: { type: Boolean, default: true },
    startDate: { type: Date, default: Date.now },
    endDate: Date,
    active: { type: Boolean, default: true, index: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: String,
  },
  { timestamps: true },
);
assignmentSchema.index({ nurseId: 1, patientId: 1, active: 1 });

export const Assignment = mongoose.model('Assignment', assignmentSchema);
