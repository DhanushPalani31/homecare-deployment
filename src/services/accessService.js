import { Assignment, CaregiverLink, Consultation, Patient } from '../models/index.js';
import { ROLES, CONSULT_STATUS } from '../utils/constants.js';
import { forbidden, notFound } from '../utils/errors.js';

/**
 * Patient-level authorization. Every route that touches a patient goes through here,
 * so the UI hiding screens is never the only line of defence.
 *
 * Returns an access context: { patient, relation, permissions }
 *   relation: ADMIN | ASSIGNED_NURSE | ASSIGNED_DOCTOR | CONSULTING_DOCTOR | SELF | CAREGIVER
 */
export async function resolvePatientAccess(user, patientId) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw notFound('Patient not found');
  const uid = user._id;

  switch (user.role) {
    case ROLES.ADMIN:
      return { patient, relation: 'ADMIN', permissions: ['*'] };

    case ROLES.NURSE: {
      const a = await Assignment.exists({ patientId, nurseId: uid, active: true });
      if (a) return { patient, relation: 'ASSIGNED_NURSE', permissions: ['CLINICAL_READ', 'CLINICAL_WRITE'] };
      break;
    }

    case ROLES.DOCTOR: {
      if (patient.assignedDoctorId?.equals(uid)) {
        return { patient, relation: 'ASSIGNED_DOCTOR', permissions: ['CLINICAL_READ', 'ADVICE_WRITE'] };
      }
      // A doctor routed a consultation may see the minimum necessary while it is open, and
      // retains read access to patients they have actually consulted on.
      const c = await Consultation.exists({
        patientId,
        $or: [
          { doctorId: uid, status: { $in: [CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL, CONSULT_STATUS.COMPLETED] } },
          { routing: { $elemMatch: { doctorId: uid, outcome: 'PENDING' } }, status: CONSULT_STATUS.REQUESTED },
        ],
      });
      if (c) return { patient, relation: 'CONSULTING_DOCTOR', permissions: ['CLINICAL_READ', 'ADVICE_WRITE'] };
      break;
    }

    case ROLES.PATIENT: {
      if (patient.userId?.equals(uid)) return { patient, relation: 'SELF', permissions: ['SELF'] };
      const link = await CaregiverLink.findOne({ patientId, caregiverUserId: uid, revokedAt: null });
      if (link) return { patient, relation: 'CAREGIVER', permissions: link.permissions };
      break;
    }
    default:
      break;
  }
  throw forbidden('You are not authorized to access this patient');
}

export const isClinical = (ctx) => ['ADMIN', 'ASSIGNED_NURSE', 'ASSIGNED_DOCTOR', 'CONSULTING_DOCTOR'].includes(ctx.relation);
export const isPatientSide = (ctx) => ['SELF', 'CAREGIVER'].includes(ctx.relation);

/** Throws unless the context allows the caregiver/self permission (SELF has all patient-side permissions). */
export function requirePatientSidePermission(ctx, perm) {
  if (isClinical(ctx) || ctx.relation === 'SELF') return;
  if (ctx.relation === 'CAREGIVER' && ctx.permissions.includes(perm)) return;
  throw forbidden('This caregiver access does not include that information');
}

/** All patient IDs a user may list. */
export async function accessiblePatientIds(user) {
  switch (user.role) {
    case ROLES.ADMIN:
      return null; // unrestricted
    case ROLES.NURSE:
      return Assignment.distinct('patientId', { nurseId: user._id, active: true });
    case ROLES.DOCTOR: {
      const assigned = await Patient.distinct('_id', { assignedDoctorId: user._id });
      const consulted = await Consultation.distinct('patientId', {
        doctorId: user._id,
        status: { $in: [CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL, CONSULT_STATUS.COMPLETED] },
      });
      return [...new Map([...assigned, ...consulted].map((id) => [String(id), id])).values()];
    }
    case ROLES.PATIENT: {
      const own = await Patient.distinct('_id', { userId: user._id });
      const linked = await CaregiverLink.distinct('patientId', { caregiverUserId: user._id, revokedAt: null });
      return [...own, ...linked];
    }
    default:
      return [];
  }
}

/**
 * Shape a patient record for the viewer. Patient/family never receive internal fields;
 * a doctor who is only consulting gets the minimum necessary clinical set.
 */
export function shapePatient(patient, ctx) {
  const p = patient.toObject ? patient.toObject() : { ...patient };
  delete p.__v;
  if (ctx.relation === 'CONSULTING_DOCTOR') {
    return {
      _id: p._id,
      patientCode: p.patientCode,
      name: p.name,
      dateOfBirth: p.dateOfBirth,
      gender: p.gender,
      allergies: p.allergies,
      currentMedications: p.currentMedications,
      medicalHistory: p.medicalHistory,
      primaryDiagnosis: p.primaryDiagnosis,
      mobilityStatus: p.mobilityStatus,
    };
  }
  if (ctx.relation === 'CAREGIVER' && !ctx.permissions.includes('VIEW_PROFILE')) {
    return { _id: p._id, patientCode: p.patientCode, name: p.name };
  }
  return p;
}
