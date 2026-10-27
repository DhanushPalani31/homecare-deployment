import mongoose from 'mongoose';
import { ROLE_LIST, ACCOUNT_STATUS } from '../utils/constants.js';

const { Schema } = mongoose;

const documentRefSchema = new Schema(
  {
    kind: { type: String, required: true }, // e.g. REGISTRATION_CERT, DEGREE, ID_PROOF
    fileId: { type: Schema.Types.ObjectId, ref: 'FileObject' },
    status: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING' },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: Date,
    note: String,
  },
  { _id: true, timestamps: true },
);

const professionalSchema = new Schema(
  {
    registrationNumber: String,
    registrationCouncil: String, // e.g. State Nursing Council / State Medical Council
    registrationValidUntil: Date,
    qualifications: [{ title: String, institution: String, year: Number }],
    specializations: [String],
    yearsOfExperience: Number,
    languages: [String],
    verificationStatus: { type: String, enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'], default: 'UNVERIFIED' },
    documents: [documentRefSchema],
    canPrescribe: { type: Boolean, default: false }, // doctors only, set by admin after verification
  },
  { _id: false },
);

const availabilitySchema = new Schema(
  {
    acceptingConsultations: { type: Boolean, default: false },
    weekly: [{ day: { type: Number, min: 0, max: 6 }, start: String, end: String }], // "09:00"
    note: String,
    updatedAt: Date,
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    role: { type: String, enum: ROLE_LIST, required: true, index: true },
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    mobile: { type: String, trim: true, unique: true, sparse: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE, index: true },
    statusReason: String,
    name: { first: { type: String, required: true }, last: String },
    gender: String,
    dateOfBirth: Date,
    avatarFileId: { type: Schema.Types.ObjectId, ref: 'FileObject' },
    employeeId: String,
    professional: professionalSchema,
    availability: availabilitySchema,
    mfaEnabled: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    mobileVerified: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    lastLoginAt: Date,
    passwordChangedAt: Date,
    tokenVersion: { type: Number, default: 0 }, // bump to invalidate every access token
    pushTokens: [{ token: String, platform: String, deviceId: String, updatedAt: Date }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

userSchema.virtual('fullName').get(function fullName() {
  return [this.name?.first, this.name?.last].filter(Boolean).join(' ');
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const o = this.toObject({ virtuals: true });
  delete o.passwordHash;
  delete o.failedLoginCount;
  delete o.lockUntil;
  delete o.pushTokens;
  delete o.tokenVersion;
  delete o.__v;
  delete o.id;
  return o;
};

export const User = mongoose.model('User', userSchema);
