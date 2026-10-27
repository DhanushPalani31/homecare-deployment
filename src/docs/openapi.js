/**
 * OpenAPI 3.1 description of the REST API and the Socket.IO signaling contract.
 * Served at /api/docs (Swagger UI) and /api/docs/openapi.json.
 */
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description = 'OK', schema) => ({ description, ...(schema && { content: { 'application/json': { schema } } }) });
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
const std = { 400: ref2('Error'), 401: ref2('Error'), 403: ref2('Error'), 404: ref2('Error') };
function ref2(name) {
  return { description: name, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } };
}

const op = (tags, summary, extra = {}) => ({ tags, summary, responses: { 200: ok(), ...std }, ...extra });

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'HomeCare – Home Healthcare & Teleconsultation API',
    version: '1.0.0',
    description:
      'REST API for administrators, nurses, doctors and patients/caregivers. All endpoints except /auth/* require a Bearer access token. ' +
      'Authorization is enforced server-side per role and per patient.\n\n' +
      '### Real-time (Socket.IO)\nConnect with `auth: { token }`. Client→server events use acknowledgements returning `{ ok, error? }`.\n\n' +
      '| Event (client→server) | Payload |\n|---|---|\n' +
      '| consultation:request | {patientId, reason, urgency, visitId?, doctorId?, consent?} |\n' +
      '| consultation:accept / decline / cancel | {consultationId, reason?} |\n' +
      '| call:join | {consultationId} → ack {isOfferer, iceServers, peerPresent} |\n' +
      '| webrtc:offer / webrtc:answer | {consultationId, negotiationId, description:{type,sdp}} |\n' +
      '| webrtc:ice-candidate | {consultationId, negotiationId, candidate} |\n' +
      '| call:connected / call:reconnect / call:end / call:failed | {consultationId, reason?} |\n' +
      '| call:media-state | {consultationId, audio, video} |\n\n' +
      '| Event (server→client) | Meaning |\n|---|---|\n' +
      '| consultation:request | Incoming request for a doctor |\n' +
      '| consultation:ringing / escalated / accepted / declined / expired / cancelled | Request lifecycle |\n' +
      '| call:ready | Both joined; nurse creates offer for `negotiationId` |\n' +
      '| webrtc:offer / answer / ice-candidate | Relayed signaling |\n' +
      '| call:peer-left / call:peer-waiting / call:connected / call:end / call:replaced | Call state |\n' +
      '| advice:ready / notification:new | Clinical notifications |',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } },
      LoginRequest: { type: 'object', required: ['identifier', 'password'], properties: { identifier: { type: 'string', description: 'email or mobile' }, password: { type: 'string' }, portal: { enum: ['mobile', 'admin'] }, device: { type: 'object', properties: { deviceId: { type: 'string' }, deviceName: { type: 'string' }, platform: { enum: ['ios', 'android', 'web'] } } } } },
      TokenPair: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, user: ref('User') } },
      User: { type: 'object', properties: { _id: { type: 'string' }, role: { enum: ['ADMIN', 'NURSE', 'DOCTOR', 'PATIENT'] }, email: { type: 'string' }, mobile: { type: 'string' }, status: { type: 'string' }, name: { type: 'object' }, professional: { type: 'object' }, availability: { type: 'object' } } },
      Patient: { type: 'object', properties: { _id: { type: 'string' }, patientCode: { type: 'string' }, name: { type: 'object' }, allergies: { type: 'array', items: { type: 'object' } }, currentMedications: { type: 'array', items: { type: 'object' } } } },
      Visit: { type: 'object', properties: { _id: { type: 'string' }, status: { enum: ['SCHEDULED', 'STARTED', 'COMPLETED', 'CANCELLED', 'MISSED'] }, scheduledStart: { type: 'string', format: 'date-time' }, assessment: { type: 'object' } } },
      VisitLocation: { type: 'object', required: ['lat', 'lng', 'accuracy'], properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 }, accuracy: { type: 'number', minimum: 0, maximum: 100, description: 'Reported accuracy in metres; values above 100 are rejected.' } } },
      ConsultationRequest: { type: 'object', required: ['patientId', 'reason', 'urgency'], properties: { patientId: { type: 'string' }, visitId: { type: 'string' }, doctorId: { type: 'string' }, parentConsultationId: { type: 'string' }, reason: { type: 'string' }, urgency: { enum: ['ROUTINE', 'URGENT', 'EMERGENCY'] }, audioOnly: { type: 'boolean' }, consent: { type: 'object', properties: { obtained: { type: 'boolean' }, method: { enum: ['VERBAL', 'WRITTEN', 'IN_APP'] } } } } },
      Consultation: { type: 'object', properties: { _id: { type: 'string' }, consultationNo: { type: 'string' }, status: { enum: ['REQUESTED', 'ACCEPTED', 'IN_CALL', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED'] }, urgency: { type: 'string' }, requestedAt: { type: 'string' }, acceptedAt: { type: 'string' }, startedAt: { type: 'string' }, endedAt: { type: 'string' }, durationSeconds: { type: 'number' }, failureReason: { type: 'string' } } },
      AdviceContent: { type: 'object', properties: { clinicalAssessment: { type: 'string' }, provisionalDiagnosis: { type: 'string' }, advice: { type: 'string' }, nursingInstructions: { type: 'string' }, prescriptions: { type: 'array', items: { type: 'object' } }, followUp: { type: 'object' }, escalation: { type: 'object' }, patientSummary: { type: 'string' } } },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/auth/login': { post: op(['Auth'], 'Login (may return an OTP challenge)', { security: [], requestBody: body(ref('LoginRequest')), responses: { 200: ok('Tokens or {otpRequired, challengeId}', ref('TokenPair')), 401: ref2('Error') } }) },
    '/auth/otp/verify': { post: op(['Auth'], 'Verify login OTP', { security: [] }) },
    '/auth/otp/resend': { post: op(['Auth'], 'Resend OTP', { security: [] }) },
    '/auth/refresh': { post: op(['Auth'], 'Rotate refresh token', { security: [] }) },
    '/auth/logout': { post: op(['Auth'], 'Logout current session') },
    '/auth/logout-all': { post: op(['Auth'], 'Logout from all devices') },
    '/auth/password/forgot': { post: op(['Auth'], 'Request a password-reset code', { security: [] }) },
    '/auth/password/reset': { post: op(['Auth'], 'Reset password with code', { security: [] }) },
    '/auth/password/change': { post: op(['Auth'], 'Change password') },
    '/auth/sessions': { get: op(['Auth'], 'List active device sessions') },
    '/auth/sessions/{id}': { delete: op(['Auth'], 'Revoke a device session', { parameters: idParam }) },
    '/me': { get: op(['Me'], 'Current user'), patch: op(['Me'], 'Update own profile (limited fields)') },
    '/me/push-token': { put: op(['Me'], 'Register FCM token') },
    '/me/availability': { put: op(['Me'], 'Doctor availability') },
    '/me/ice-servers': { get: op(['Calls'], 'Short-lived STUN/TURN credentials') },
    '/dashboard': { get: op(['Dashboard'], 'Role-specific dashboard') },
    '/users': { get: op(['Admin: Staff'], 'List users'), post: op(['Admin: Staff'], 'Create user') },
    '/users/doctors/available': { get: op(['Consultations'], 'Doctors and availability (nurse picker)') },
    '/users/{id}': { get: op(['Admin: Staff'], 'Get user', { parameters: idParam }), patch: op(['Admin: Staff'], 'Update user', { parameters: idParam }) },
    '/users/{id}/status': { post: op(['Admin: Staff'], 'Activate / suspend / deactivate', { parameters: idParam }) },
    '/users/{id}/reset-password': { post: op(['Admin: Staff'], 'Admin password reset', { parameters: idParam }) },
    '/users/{id}/credentials': { post: op(['Admin: Staff'], 'Upload credential document (multipart)', { parameters: idParam }) },
    '/patients': { get: op(['Patients'], 'List accessible patients'), post: op(['Patients'], 'Register patient (admin)') },
    '/patients/{id}': { get: op(['Patients'], 'Get patient (shaped by relation)', { parameters: idParam }), patch: op(['Patients'], 'Update patient (field-level permissions)', { parameters: idParam }) },
    '/patients/{id}/clinical-summary': { get: op(['Patients'], 'Care plan, allergies, history, recent vitals and advice', { parameters: idParam }) },
    '/patients/{id}/team': { get: op(['Patients'], 'Assigned nurse(s) and doctor', { parameters: idParam }) },
    '/patients/{id}/consents': { post: op(['Patients'], 'Record consent', { parameters: idParam }) },
    '/patients/{id}/privacy': { patch: op(['Patients'], 'Privacy settings', { parameters: idParam }) },
    '/patients/{id}/caregivers': { get: op(['Patients'], 'List caregivers', { parameters: idParam }), post: op(['Patients'], 'Grant caregiver access', { parameters: idParam }) },
    '/patients/{id}/caregivers/{linkId}': { delete: op(['Patients'], 'Revoke caregiver access') },
    '/patients/{id}/visits': { get: op(['Patients'], 'Patient visits', { parameters: idParam }) },
    '/patients/{id}/care-plans': { get: op(['Patients'], 'Care plans', { parameters: idParam }) },
    '/patients/{id}/summaries': { get: op(['Patients'], 'Approved clinical summaries (patient/family)', { parameters: idParam }) },
    '/patients/{id}/consultations': { get: op(['Patients'], 'Consultation history (clinical)', { parameters: idParam }) },
    '/patients/{id}/invoices': { get: op(['Billing'], 'Patient invoices', { parameters: idParam }) },
    '/patients/{id}/files': { get: op(['Files'], 'List documents', { parameters: idParam }), post: op(['Files'], 'Upload document (multipart: file, category, consentConfirmed)', { parameters: idParam }) },
    '/files/{id}': { get: op(['Files'], 'Download document', { parameters: idParam }) },
    '/files/{id}/link': { post: op(['Files'], 'Issue a 60-second signed download link', { parameters: idParam }) },
    '/files/download/{token}': { get: op(['Files'], 'Redeem signed download link', { security: [] }) },
    '/visits': { get: op(['Visits'], 'List visits (nurse: own; admin: all)'), post: op(['Visits'], 'Schedule one-time or recurring visits (admin)') },
    '/visits/{id}': { get: op(['Visits'], 'Get visit', { parameters: idParam }), patch: op(['Visits'], 'Reschedule / reassign', { parameters: idParam }) },
    '/visits/{id}/cancel': { post: op(['Visits'], 'Cancel visit or remainder of series', { parameters: idParam }) },
    '/visits/{id}/start': {
      post: op(['Visits'], 'Nurse check-in with patient verification and GPS (server timestamp; within 150 m of the saved patient location)', {
        parameters: idParam,
        requestBody: body({
          type: 'object',
          required: ['patientVerified', 'verificationMethod', 'geo'],
          properties: {
            patientVerified: { type: 'boolean', const: true },
            verificationMethod: { enum: ['PHOTO_ID', 'NAME_DOB', 'FAMILY_CONFIRMED', 'KNOWN_PATIENT'] },
            geo: { $ref: '#/components/schemas/VisitLocation' },
          },
        }),
      }),
    },
    '/visits/{id}/assessment': { put: op(['Visits'], 'Save assessment draft / final (vitals, notes, MAR)', { parameters: idParam }) },
    '/visits/{id}/complete': {
      post: op(['Visits'], 'Nurse check-out with summary and GPS (within 150 m of the saved patient location)', {
        parameters: idParam,
        requestBody: body({
          type: 'object',
          required: ['summary', 'geo'],
          properties: {
            summary: { type: 'string', minLength: 10, maxLength: 3000 },
            shareSummaryWithPatient: { type: 'boolean', default: true },
            geo: { $ref: '#/components/schemas/VisitLocation' },
          },
        }),
      }),
    },
    '/attendance': {
      get: op(['Attendance'], 'Nurse monthly visit attendance and server-recorded check-in/out times', {
        parameters: [{ name: 'month', in: 'query', required: false, description: 'YYYY-MM; defaults to the current UTC month.', schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } }],
      }),
    },
    '/leaves': {
      get: op(['Leave'], 'Nurse monthly leave requests', {
        parameters: [{ name: 'month', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } }],
      }),
      post: op(['Leave'], 'Submit leave request', {
        requestBody: body({
          type: 'object',
          required: ['startDate', 'endDate', 'type', 'reason'],
          properties: {
            startDate: { type: 'string', format: 'date' },
            endDate: { type: 'string', format: 'date' },
            type: { enum: ['ANNUAL', 'SICK', 'EMERGENCY', 'OTHER'] },
            reason: { type: 'string', minLength: 5, maxLength: 1000 },
          },
        }),
        responses: { 201: ok('Created'), ...std, 409: ref2('Error') },
      }),
    },
    '/leaves/{id}/cancel': { post: op(['Leave'], 'Cancel pending leave request', { parameters: idParam }) },
    '/admin/attendance': {
      get: op(['Attendance'], 'Monthly nurse attendance report for administrators', {
        parameters: [
          { name: 'month', in: 'query', required: false, description: 'YYYY-MM; defaults to the current UTC month.', schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
          { name: 'nurseId', in: 'query', required: false, schema: { type: 'string' } },
        ],
      }),
    },
    '/admin/leaves': {
      get: op(['Leave'], 'Monthly leave report for administrators', {
        parameters: [
          { name: 'month', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
          { name: 'nurseId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] } },
        ],
      }),
    },
    '/admin/leaves/{id}': {
      patch: op(['Leave'], 'Approve or reject a pending nurse leave request', {
        parameters: idParam,
        requestBody: body({
          type: 'object',
          required: ['status'],
          properties: { status: { enum: ['APPROVED', 'REJECTED'] }, reviewNote: { type: 'string', maxLength: 500 } },
        }),
      }),
    },
    '/care/categories': { get: op(['Care'], 'Service categories'), post: op(['Care'], 'Create category') },
    '/care/services': { get: op(['Care'], 'Services & pricing'), post: op(['Care'], 'Create service') },
    '/care/assignments': { get: op(['Care'], 'Nurse assignments'), post: op(['Care'], 'Assign / reassign nurse') },
    '/care/assignments/{id}/end': { post: op(['Care'], 'End assignment', { parameters: idParam }) },
    '/care/care-plans': { get: op(['Care'], 'Care plans'), post: op(['Care'], 'Create care plan') },
    '/consultations': { get: op(['Consultations'], 'List (role-scoped)'), post: op(['Consultations'], 'Request doctor opinion', { requestBody: body(ref('ConsultationRequest')), responses: { 201: ok('Created', ref('Consultation')), ...std, 409: ref2('Error'), 422: ref2('Error') } }) },
    '/consultations/{id}': { get: op(['Consultations'], 'Consultation detail + advice', { parameters: idParam }) },
    '/consultations/{id}/accept': { post: op(['Consultations'], 'Doctor accepts', { parameters: idParam }) },
    '/consultations/{id}/decline': { post: op(['Consultations'], 'Doctor declines (auto-escalates)', { parameters: idParam }) },
    '/consultations/{id}/cancel': { post: op(['Consultations'], 'Nurse cancels before connect', { parameters: idParam }) },
    '/consultations/{id}/end': { post: op(['Consultations'], 'End call (REST fallback)', { parameters: idParam }) },
    '/consultations/{id}/advice': { put: op(['Advice'], 'Save advice draft', { parameters: idParam, requestBody: body(ref('AdviceContent')) }) },
    '/consultations/{id}/advice/sign': { post: op(['Advice'], 'Sign advice', { parameters: idParam }) },
    '/consultations/{id}/advice/amend': { post: op(['Advice'], 'Amend signed advice (author only, with reason)', { parameters: idParam }) },
    '/consultations/{id}/advice/approve-summary': { post: op(['Advice'], 'Release patient summary to patient/family', { parameters: idParam }) },
    '/consultations/{id}/advice/acknowledge': { post: op(['Advice'], 'Nurse acknowledges advice + actions taken', { parameters: idParam }) },
    '/notifications': { get: op(['Notifications'], 'My notifications') },
    '/notifications/{id}/read': { post: op(['Notifications'], 'Mark read', { parameters: idParam }) },
    '/notifications/read-all': { post: op(['Notifications'], 'Mark all read') },
    '/notifications/broadcast': { post: op(['Notifications'], 'Admin broadcast') },
    '/admin/invoices': { get: op(['Billing'], 'List invoices') },
    '/admin/invoices/generate': { post: op(['Billing'], 'Generate draft invoice from completed visits') },
    '/admin/invoices/{id}/issue': { post: op(['Billing'], 'Issue invoice', { parameters: idParam }) },
    '/admin/invoices/{id}/payments': { post: op(['Billing'], 'Record payment', { parameters: idParam }) },
    '/admin/invoices/{id}/void': { post: op(['Billing'], 'Void invoice', { parameters: idParam }) },
    '/admin/reports/summary': { get: op(['Reports'], 'Daily / weekly / monthly summary') },
    '/admin/reports/export': { get: op(['Reports'], 'Export CSV / XLSX') },
    '/admin/audit': { get: op(['Audit'], 'Audit log') },
    '/admin/settings': { get: op(['Settings'], 'Get settings'), put: op(['Settings'], 'Update settings') },
  },
};
