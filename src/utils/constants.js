export const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  NURSE: 'NURSE',
  DOCTOR: 'DOCTOR',
  PATIENT: 'PATIENT',
});
export const ROLE_LIST = Object.values(ROLES);

export const ACCOUNT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
});

export const VISIT_STATUS = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  MISSED: 'MISSED',
});

export const CONSULT_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED', // ringing a doctor
  ACCEPTED: 'ACCEPTED', // doctor accepted, room open, waiting for media
  IN_CALL: 'IN_CALL', // media connected at least once
  COMPLETED: 'COMPLETED', // call ended normally
  DECLINED: 'DECLINED', // every routed doctor declined
  CANCELLED: 'CANCELLED', // nurse cancelled before connect
  EXPIRED: 'EXPIRED', // nobody answered in time
  FAILED: 'FAILED', // technical failure
});
export const CONSULT_OPEN = [CONSULT_STATUS.REQUESTED, CONSULT_STATUS.ACCEPTED, CONSULT_STATUS.IN_CALL];

export const URGENCY = Object.freeze({ ROUTINE: 'ROUTINE', URGENT: 'URGENT', EMERGENCY: 'EMERGENCY' });

export const ADVICE_STATUS = Object.freeze({ DRAFT: 'DRAFT', SIGNED: 'SIGNED', AMENDED: 'AMENDED' });

export const CAREGIVER_PERMISSIONS = [
  'VIEW_PROFILE',
  'VIEW_APPOINTMENTS',
  'VIEW_SUMMARIES',
  'VIEW_DOCUMENTS',
  'VIEW_BILLING',
  'VIEW_CARE_PLAN',
];
