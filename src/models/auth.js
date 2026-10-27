import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One row per device login. Refresh tokens are stored only as SHA-256 hashes.
 * Rotation: each refresh marks the row's current hash as used and issues a new one
 * in the same family. Presenting an already-rotated token revokes the whole family
 * (stolen-token detection).
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    previousHashes: { type: [String], default: [], select: false },
    deviceId: String,
    deviceName: String,
    platform: String,
    userAgent: String,
    ip: String,
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
  },
  { timestamps: false },
);
sessionSchema.index({ previousHashes: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const Session = mongoose.model('Session', sessionSchema);

const otpSchema = new Schema({
  challengeId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  target: { type: String, required: true }, // email or mobile the code was sent to
  channel: { type: String, enum: ['EMAIL', 'SMS'], required: true },
  purpose: { type: String, enum: ['LOGIN', 'PASSWORD_RESET', 'VERIFY_CONTACT'], required: true },
  codeHash: { type: String, required: true }, // HMAC, never the code
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: Date,
  createdAt: { type: Date, default: Date.now },
  meta: Schema.Types.Mixed,
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
otpSchema.index({ target: 1, purpose: 1, createdAt: -1 });

export const Otp = mongoose.model('Otp', otpSchema);
