import mongoose from 'mongoose';

const leaveRequestSchema = new mongoose.Schema(
  {
    nurseId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, required: true, index: true },
    type: { type: String, enum: ['ANNUAL', 'SICK', 'EMERGENCY', 'OTHER'], required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

leaveRequestSchema.index({ nurseId: 1, startDate: 1, endDate: 1 });

export const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);
