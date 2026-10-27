/**
 * End-to-end tests against a real (in-memory) MongoDB, the real Express app and
 * a real Socket.IO server. Covers auth, token rotation, RBAC, patient-level access,
 * visit workflow, consultation routing and WebRTC signaling authorization.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioc } from 'socket.io-client';

let mongo, server, base, request, seedData, mongoose;

process.env.NODE_ENV = 'test';
process.env.EXPOSE_DEV_OTP = 'true';
process.env.CONSULT_RING_TIMEOUT_SECONDS = '3';
process.env.CALL_RECONNECT_GRACE_SECONDS = '2';
process.env.TURN_URLS = 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp';
process.env.TURN_STATIC_AUTH_SECRET = 'test-turn-secret';
process.env.UPLOAD_DIR = './.test-uploads';

const tokens = {};
const sockets = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('homecare_test');
  mongoose = (await import('mongoose')).default;
  const { connectDb } = await import('../src/config/db.js');
  const { createApp } = await import('../src/app.js');
  const { initSocket } = await import('../src/socket/index.js');
  const { seed } = await import('../src/scripts/seed.js');
  request = (await import('supertest')).default;
  await connectDb(process.env.MONGODB_URI);
  seedData = await seed();
  await mongoose.connection.syncIndexes();
  const app = createApp();
  server = http.createServer(app);
  initSocket(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const who of ['admin', 'nurse1', 'nurse2', 'doctor1', 'doctor2', 'patient1', 'family1']) {
    const res = await request(base).post('/api/v1/auth/login').send({ identifier: `${who}@homecare.test`, password: seedData.password, device: { deviceId: `${who}-dev`, platform: 'android' } });
    assert.equal(res.status, 200, `${who} login: ${JSON.stringify(res.body)}`);
    tokens[who] = res.body;
  }
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await new Promise((r) => server?.close(r));
  await mongoose?.disconnect();
  await mongo?.stop();
  const fs = await import('node:fs');
  fs.rmSync('./.test-uploads', { recursive: true, force: true });
  setTimeout(() => process.exit(0), 200).unref(); // background intervals
});

const api = (who) => {
  const auth = (r) => r.set('Authorization', `Bearer ${tokens[who].accessToken}`);
  return {
    get: (p) => auth(request(base).get(`/api/v1${p}`)),
    post: (p, b) => auth(request(base).post(`/api/v1${p}`)).send(b),
    put: (p, b) => auth(request(base).put(`/api/v1${p}`)).send(b),
    patch: (p, b) => auth(request(base).patch(`/api/v1${p}`)).send(b),
  };
};

function connect(who) {
  return new Promise((resolve, reject) => {
    const s = ioc(base, { auth: { token: tokens[who].accessToken }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const once = (s, ev, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });

/* ===================================================================== auth */

describe('authentication', () => {
  test('server-issued role comes back on login', () => {
    assert.equal(tokens.nurse1.user.role, 'NURSE');
    assert.equal(tokens.doctor1.user.role, 'DOCTOR');
    assert.equal(tokens.admin.user.passwordHash, undefined);
  });

  test('wrong password is rejected generically and locks after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(base).post('/api/v1/auth/login').send({ identifier: 'nurse2@homecare.test', password: 'wrong-password-1' });
      assert.equal(r.status, 401);
    }
    const locked = await request(base).post('/api/v1/auth/login').send({ identifier: 'nurse2@homecare.test', password: seedData.password });
    assert.equal(locked.status, 401, 'account should be temporarily locked even with right password');
    const { User } = await import('../src/models/index.js');
    await User.updateOne({ email: 'nurse2@homecare.test' }, { $unset: { lockUntil: 1 } });
  });

  test('unknown user gets the same error as wrong password', async () => {
    const r = await request(base).post('/api/v1/auth/login').send({ identifier: 'nobody@homecare.test', password: 'whatever123' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.message, 'Invalid credentials');
  });

  test('admin portal rejects non-admin login', async () => {
    const r = await request(base).post('/api/v1/auth/login').send({ identifier: 'nurse1@homecare.test', password: seedData.password, portal: 'admin' });
    assert.equal(r.status, 403);
  });

  test('refresh rotates tokens and reuse of an old refresh token revokes the session family', async () => {
    const login = await request(base).post('/api/v1/auth/login').send({ identifier: 'doctor2@homecare.test', password: seedData.password });
    const r1 = await request(base).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refreshToken, login.body.refreshToken);
    const reuse = await request(base).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    assert.equal(reuse.status, 401);
    const afterReuse = await request(base).post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    assert.equal(afterReuse.status, 401, 'whole family revoked after reuse');
    const me = await request(base).get('/api/v1/me').set('Authorization', `Bearer ${r1.body.accessToken}`);
    assert.equal(me.status, 401, 'access token of revoked session is rejected');
  });

  test('logout invalidates the access token immediately', async () => {
    const login = await request(base).post('/api/v1/auth/login').send({ identifier: 'patient1@homecare.test', password: seedData.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    assert.equal((await request(base).get('/api/v1/me').set(auth)).status, 200);
    assert.equal((await request(base).post('/api/v1/auth/logout').set(auth)).status, 204);
    assert.equal((await request(base).get('/api/v1/me').set(auth)).status, 401);
  });

  test('password reset via OTP: wrong code counted, right code resets and revokes sessions', async () => {
    const f = await request(base).post('/api/v1/auth/password/forgot').send({ identifier: 'family1@homecare.test' });
    assert.equal(f.status, 200);
    assert.match(f.body.devCode, /^\d{6}$/);
    const bad = await request(base).post('/api/v1/auth/password/reset').send({ challengeId: f.body.challengeId, code: f.body.devCode === '000000' ? '111111' : '000000', newPassword: 'NewPassword123' });
    assert.equal(bad.status, 400);
    const good = await request(base).post('/api/v1/auth/password/reset').send({ challengeId: f.body.challengeId, code: f.body.devCode, newPassword: 'NewPassword123' });
    assert.equal(good.status, 200);
    const replay = await request(base).post('/api/v1/auth/password/reset').send({ challengeId: f.body.challengeId, code: f.body.devCode, newPassword: 'OtherPassword123' });
    assert.equal(replay.status, 400, 'OTP is single use');
    assert.equal((await api('family1').get('/me')).status, 401, 'old sessions revoked');
    const relog = await request(base).post('/api/v1/auth/login').send({ identifier: 'family1@homecare.test', password: 'NewPassword123' });
    assert.equal(relog.status, 200);
    tokens.family1 = relog.body;
  });

  test('forgot-password does not reveal whether an account exists', async () => {
    const r = await request(base).post('/api/v1/auth/password/forgot').send({ identifier: 'ghost@homecare.test' });
    assert.equal(r.status, 200);
    assert.ok(r.body.challengeId);
  });
});

/* ===================================================================== RBAC */

describe('role and patient-level authorization', () => {
  const p = (i) => String(seedData.patients[i]._id);

  test('non-admins cannot use admin endpoints', async () => {
    for (const who of ['nurse1', 'doctor1', 'patient1']) {
      assert.equal((await api(who).get('/users')).status, 403);
      assert.equal((await api(who).get('/admin/audit')).status, 403);
    }
  });

  test('nurse sees only assigned patients', async () => {
    const list = await api('nurse1').get('/patients');
    const codes = list.body.data.map((x) => String(x._id)).sort();
    assert.deepEqual(codes, [p(0), p(1)].sort());
    assert.equal((await api('nurse1').get(`/patients/${p(2)}`)).status, 403);
    assert.equal((await api('nurse2').get(`/patients/${p(0)}`)).status, 403);
  });

  test('doctor without a relationship cannot read a patient', async () => {
    assert.equal((await api('doctor2').get(`/patients/${p(0)}`)).status, 403);
    assert.equal((await api('doctor1').get(`/patients/${p(0)}`)).status, 200, 'assigned doctor can');
  });

  test('patient and caregiver access is limited to their own record and granted permissions', async () => {
    assert.equal((await api('patient1').get(`/patients/${p(0)}`)).status, 200);
    assert.equal((await api('patient1').get(`/patients/${p(1)}`)).status, 403);
    assert.equal((await api('family1').get(`/patients/${p(0)}/visits`)).status, 200);
    assert.equal((await api('family1').get(`/patients/${p(0)}/invoices`)).status, 403, 'no VIEW_BILLING');
    assert.equal((await api('family1').get(`/patients/${p(0)}/caregivers`)).status, 403);
    assert.equal((await api('patient1').get(`/patients/${p(0)}/clinical-summary`)).status, 403, 'clinical summary is staff-only');
  });

  test('field-level edit rules', async () => {
    assert.equal((await api('patient1').patch(`/patients/${p(0)}`, { primaryDiagnosis: 'self-edited' })).status, 403);
    assert.equal((await api('patient1').patch(`/patients/${p(0)}`, { phone: '+919999999999' })).status, 200);
    assert.equal((await api('nurse1').patch(`/patients/${p(0)}`, { allergies: [{ substance: 'Sulfa', severity: 'MILD' }, { substance: 'Penicillin', severity: 'MODERATE' }] })).status, 200);
  });

  test('caregiver revocation takes effect immediately', async () => {
    const links = await api('patient1').get(`/patients/${p(0)}/caregivers`);
    const link = links.body.data.find((l) => !l.revokedAt);
    assert.ok(link);
    assert.equal((await api('patient1').post(`/patients/${p(0)}/caregivers/${link._id}`).send()).status, 404); // POST not allowed path
    const del = await request(base).delete(`/api/v1/patients/${p(0)}/caregivers/${link._id}`).set('Authorization', `Bearer ${tokens.patient1.accessToken}`);
    assert.equal(del.status, 200);
    assert.equal((await api('family1').get(`/patients/${p(0)}`)).status, 403);
    // re-grant for later tests
    const g = await api('patient1').post(`/patients/${p(0)}/caregivers`, { caregiverUserId: String(seedData.caregiver._id), relation: 'Son', permissions: ['VIEW_APPOINTMENTS', 'VIEW_SUMMARIES'] });
    assert.equal(g.status, 201);
  });
});

/* ===================================================================== visit workflow */

let visitId;
describe('nurse visit workflow', () => {
  test('start visit, save draft assessment, others cannot edit', async () => {
    const list = await api('nurse1').get('/visits');
    const v = list.body.data.find((x) => String(x.patientId._id) === String(seedData.patients[0]._id) && x.status === 'SCHEDULED');
    visitId = v._id;
    assert.equal((await api('nurse2').post(`/visits/${visitId}/start`, { patientVerified: true, verificationMethod: 'NAME_DOB', geo: { lat: 13.04, lng: 80.25, accuracy: 5 } })).status, 403);
    const patientWithoutLocation = list.body.data.find((x) => String(x.patientId._id) === String(seedData.patients[1]._id) && x.status === 'SCHEDULED');
    const blocked = await api('nurse1').post(`/visits/${patientWithoutLocation._id}/start`, { patientVerified: true, verificationMethod: 'NAME_DOB', geo: { lat: 13.04, lng: 80.25, accuracy: 5 } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'PATIENT_LOCATION_MISSING');
    const noLocation = await api('nurse1').post(`/visits/${visitId}/start`, { patientVerified: true, verificationMethod: 'NAME_DOB' });
    assert.equal(noLocation.status, 400, 'location is required to check in');
    const outsideLocation = await api('nurse1').post(`/visits/${visitId}/start`, { patientVerified: true, verificationMethod: 'NAME_DOB', geo: { lat: 13.05, lng: 80.25, accuracy: 5 } });
    assert.equal(outsideLocation.status, 403, 'check-in is blocked away from patient location');
    const start = await api('nurse1').post(`/visits/${visitId}/start`, { patientVerified: true, verificationMethod: 'NAME_DOB', geo: { lat: 13.04, lng: 80.25, accuracy: 5 } });
    assert.equal(start.status, 200);
    assert.equal(start.body.visit.status, 'STARTED');
    assert.ok(start.body.visit.checkIn.at);

    const bad = await api('nurse1').put(`/visits/${visitId}/assessment`, { vitals: { systolic: 80, diastolic: 120 } });
    assert.equal(bad.status, 400, 'systolic must exceed diastolic');

    const draft = await api('nurse1').put(`/visits/${visitId}/assessment`, {
      isDraft: true,
      vitals: { systolic: 168, diastolic: 96, temperatureC: 38.4, pulse: 104, respiratoryRate: 22, spo2: 93, bloodGlucose: 286, glucoseContext: 'RANDOM' },
      symptoms: ['Fever', 'Wound discharge'],
      observations: 'Purulent discharge from heel ulcer, surrounding erythema 3 cm.',
      nursingNotes: 'INTERNAL: family reports missed doses',
      medicationAdministration: [{ medication: 'Metformin 500mg', status: 'HELD' }],
    });
    assert.equal(draft.status, 400, 'held medication needs a reason');
    const ok = await api('nurse1').put(`/visits/${visitId}/assessment`, {
      isDraft: true,
      vitals: { systolic: 168, diastolic: 96, temperatureC: 38.4, pulse: 104, respiratoryRate: 22, spo2: 93, bloodGlucose: 286, glucoseContext: 'RANDOM' },
      symptoms: ['Fever', 'Wound discharge'],
      observations: 'Purulent discharge from heel ulcer, surrounding erythema 3 cm.',
      nursingNotes: 'INTERNAL: family reports missed doses',
      medicationAdministration: [{ medication: 'Metformin 500mg', status: 'HELD', reason: 'Awaiting doctor review' }],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.visit.assessment.isDraft, true);
  });

  test('patient sees the visit without assessment or nursing notes', async () => {
    const r = await api('patient1').get(`/visits/${visitId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.visit.assessment, undefined);
    assert.ok(!JSON.stringify(r.body).includes('INTERNAL'));
  });
});

/* ===================================================================== consultation + signaling */

let consultId;
describe('consultation request, routing and WebRTC signaling', () => {
  let nurseS, doc1S, doc2S, nurse2S;

  before(async () => {
    [nurseS, doc1S, doc2S, nurse2S] = await Promise.all([connect('nurse1'), connect('doctor1'), connect('doctor2'), connect('nurse2')]);
  });

  test('socket rejects missing / bad tokens', async () => {
    await assert.rejects(
      new Promise((res, rej) => {
        const s = ioc(base, { auth: { token: 'garbage' }, transports: ['websocket'], forceNew: true });
        sockets.push(s);
        s.on('connect', res);
        s.on('connect_error', rej);
      }),
    );
  });

  test('nurse cannot request for an unassigned patient', async () => {
    const r = await api('nurse1').post('/consultations', { patientId: String(seedData.patients[2]._id), reason: 'Check please', urgency: 'URGENT' });
    assert.equal(r.status, 403);
  });

  test('request routes to the assigned doctor with minimum necessary info', async () => {
    const incoming = once(doc1S, 'consultation:request');
    const ringing = once(nurseS, 'consultation:ringing');
    const r = await api('nurse1').post('/consultations', {
      patientId: String(seedData.patients[0]._id),
      visitId,
      reason: 'Fever 38.4, SpO2 93%, purulent discharge from heel ulcer. Need opinion on antibiotics / transfer.',
      urgency: 'URGENT',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.consultation.status, 'REQUESTED');
    assert.equal(r.body.consultation.roomId, undefined, 'room id is never exposed');
    consultId = r.body.consultation._id;
    const req = await incoming;
    await ringing;
    assert.equal(req.consultationId, consultId);
    assert.equal(req.observations.vitals.spo2, 93, 'snapshot from the visit');
    assert.equal(req.patient.currentMedications, undefined, 'only minimum necessary in the ring payload');
    assert.ok(req.patient.allergies.length);

    const dup = await api('nurse1').post('/consultations', { patientId: String(seedData.patients[0]._id), reason: 'duplicate request', urgency: 'URGENT' });
    assert.equal(dup.status, 409);
  });

  test('a doctor who was not offered cannot accept; outsiders cannot join', async () => {
    const r = await emit(doc2S, 'consultation:accept', { consultationId: consultId });
    assert.equal(r.ok, false);
    const j = await emit(nurse2S, 'call:join', { consultationId: consultId });
    assert.equal(j.ok, false);
  });

  test('accept → join → ready → offer/answer/ICE relay with stale-candidate protection', async () => {
    const accepted = once(nurseS, 'consultation:accepted');
    const a = await emit(doc1S, 'consultation:accept', { consultationId: consultId });
    assert.equal(a.ok, true, JSON.stringify(a));
    await accepted;

    const doctorBusy = await emit(doc1S, 'consultation:accept', { consultationId: consultId });
    assert.equal(doctorBusy.ok, false, 'cannot accept twice');

    const outsiderJoin = await emit(doc2S, 'call:join', { consultationId: consultId });
    assert.equal(outsiderJoin.ok, false);
    assert.equal(outsiderJoin.error.code, 'FORBIDDEN');

    const jn = await emit(nurseS, 'call:join', { consultationId: consultId });
    assert.equal(jn.ok, true);
    assert.equal(jn.isOfferer, true);
    assert.equal(jn.peerPresent, false);
    const turn = jn.iceServers.find((s) => s.username);
    assert.ok(turn, 'short-lived TURN credentials issued');
    assert.match(turn.username, /^\d+:/);

    const readyN = once(nurseS, 'call:ready');
    const readyD = once(doc1S, 'call:ready');
    const jd = await emit(doc1S, 'call:join', { consultationId: consultId });
    assert.equal(jd.ok, true);
    assert.equal(jd.isOfferer, false);
    const [rn] = await Promise.all([readyN, readyD]);
    const nid = rn.negotiationId;

    // Doctor may not send offers (prevents glare / duplicate offers)
    const docOffer = await emit(doc1S, 'webrtc:offer', { consultationId: consultId, negotiationId: nid, description: { type: 'offer', sdp: 'v=0 fake sdp' } });
    assert.equal(docOffer.ok, false);

    const gotOffer = once(doc1S, 'webrtc:offer');
    assert.equal((await emit(nurseS, 'webrtc:offer', { consultationId: consultId, negotiationId: nid, description: { type: 'offer', sdp: 'v=0 nurse offer' } })).ok, true);
    assert.equal((await gotOffer).description.sdp, 'v=0 nurse offer');

    const gotAnswer = once(nurseS, 'webrtc:answer');
    assert.equal((await emit(doc1S, 'webrtc:answer', { consultationId: consultId, negotiationId: nid, description: { type: 'answer', sdp: 'v=0 doctor answer' } })).ok, true);
    assert.equal((await gotAnswer).description.sdp, 'v=0 doctor answer');

    const gotIce = once(doc1S, 'webrtc:ice-candidate');
    await emit(nurseS, 'webrtc:ice-candidate', { consultationId: consultId, negotiationId: nid, candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    assert.match((await gotIce).candidate.candidate, /typ host/);

    const stale = await emit(nurseS, 'webrtc:ice-candidate', { consultationId: consultId, negotiationId: nid - 1 || 999, candidate: { candidate: 'candidate:old', sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal(stale.dropped, 'STALE_NEGOTIATION');

    // Outsider cannot inject signaling even with the consultation id
    const inject = await emit(doc2S, 'webrtc:ice-candidate', { consultationId: consultId, negotiationId: nid, candidate: { candidate: 'candidate:evil', sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal(inject.ok, false);

    assert.equal((await emit(nurseS, 'call:connected', { consultationId: consultId })).ok, true);
    const c = await api('admin').get(`/consultations/${consultId}`);
    assert.equal(c.body.consultation.status, 'IN_CALL');
    assert.ok(c.body.consultation.startedAt);
  });

  test('ICE restart bumps negotiation id', async () => {
    const ready = once(nurseS, 'call:ready');
    assert.equal((await emit(doc1S, 'call:reconnect', { consultationId: consultId })).ok, true);
    const r = await ready;
    assert.equal(r.iceRestart, true);
    assert.ok(r.negotiationId >= 2);
  });

  test('doctor is busy for other requests while in a call', async () => {
    const r = await api('nurse1').post('/consultations', { patientId: String(seedData.patients[1]._id), reason: 'Second patient question', urgency: 'ROUTINE', doctorId: String(seedData.doctor1._id), consent: { obtained: true, method: 'VERBAL' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'DOCTOR_BUSY');
  });

  test('ending the call persists outcome and duration', async () => {
    await sleep(1100);
    const endEvt = once(doc1S, 'call:end');
    const e = await emit(nurseS, 'call:end', { consultationId: consultId });
    assert.equal(e.ok, true);
    assert.equal(e.consultation.status, 'COMPLETED');
    assert.ok(e.consultation.durationSeconds >= 1);
    await endEvt;
    const again = await emit(nurseS, 'webrtc:offer', { consultationId: consultId, negotiationId: 1, description: { type: 'offer', sdp: 'v=0 late' } });
    assert.equal(again.ok, false, 'room closed');
  });

  test('advice: draft hidden from nurse, signed, acknowledged; only author may amend', async () => {
    const content = {
      clinicalAssessment: 'Likely infected diabetic foot ulcer with early systemic response.',
      advice: 'Start oral antibiotic, wound swab, recheck vitals in 4 hours. Transfer if SpO2 < 92 or BP falls.',
      prescriptions: [{ medication: 'Doxycycline', strength: '100 mg', frequency: 'BD', durationDays: 7 }],
      followUp: { required: true, inHours: 24, instructions: 'Video follow-up tomorrow' },
      patientSummary: 'The doctor reviewed the foot wound and started an antibiotic. The nurse will check again tomorrow.',
    };
    assert.equal((await api('doctor2').put(`/consultations/${consultId}/advice`, content)).status, 403);
    assert.equal((await api('doctor1').put(`/consultations/${consultId}/advice`, content)).status, 200);
    const nurseView = await api('nurse1').get(`/consultations/${consultId}`);
    assert.equal(nurseView.body.advice, null, 'draft not visible to nurse');

    const readyEvt = once(nurseS, 'advice:ready');
    const sign = await api('doctor1').post(`/consultations/${consultId}/advice/sign`);
    assert.equal(sign.status, 200);
    assert.match(sign.body.advice.signatureHash, /^[a-f0-9]{64}$/);
    await readyEvt;

    assert.equal((await api('doctor1').put(`/consultations/${consultId}/advice`, content)).status, 409, 'signed advice cannot be overwritten');
    assert.equal((await api('doctor2').post(`/consultations/${consultId}/advice/amend`, { reason: 'I disagree', content })).status, 403);

    const ack = await api('nurse1').post(`/consultations/${consultId}/advice/acknowledge`, { nurseActions: 'First dose given 14:10, swab sent, vitals rechecked.' });
    assert.equal(ack.status, 200);

    const amend = await api('doctor1').post(`/consultations/${consultId}/advice/amend`, { reason: 'Penicillin allergy confirmed; dose clarification', content: { ...content, advice: content.advice + ' Take with food.' } });
    assert.equal(amend.status, 200);
    assert.equal(amend.body.advice.version, 2);
    assert.equal(amend.body.advice.amendments.length, 1);
    assert.equal(amend.body.advice.acknowledgement, undefined, 'nurse must re-acknowledge');

    // Patient sees summaries only after approval
    let s = await api('patient1').get(`/patients/${seedData.patients[0]._id}/summaries`);
    assert.equal(s.body.consultations.length, 0);
    assert.equal((await api('doctor1').post(`/consultations/${consultId}/advice/approve-summary`)).status, 200);
    s = await api('patient1').get(`/patients/${seedData.patients[0]._id}/summaries`);
    assert.equal(s.body.consultations.length, 1);
    assert.ok(!JSON.stringify(s.body).includes('Doxycycline'), 'raw prescription not exposed in summary');
  });

  test('doctor without prescribing rights cannot prescribe', async () => {
    const { Consultation } = await import('../src/models/index.js');
    await Consultation.updateOne({ _id: consultId }, { doctorId: seedData.doctor2._id });
    const r = await api('doctor2').put(`/consultations/${consultId}/advice`, { advice: 'x', prescriptions: [{ medication: 'Anything' }] });
    assert.ok([403, 409].includes(r.status));
    await Consultation.updateOne({ _id: consultId }, { doctorId: seedData.doctor1._id });
  });

  test('decline escalates to the next available doctor, then closes as DECLINED', async () => {
    const pid = String(seedData.patients[1]._id);
    const d1 = once(doc1S, 'consultation:request');
    const r = await api('nurse1').post('/consultations', { patientId: pid, reason: 'Chest discomfort post CABG', urgency: 'EMERGENCY', consent: { obtained: true, method: 'VERBAL' } });
    assert.equal(r.status, 201);
    const cid = r.body.consultation._id;
    await d1;
    const d2 = once(doc2S, 'consultation:request');
    const escalated = once(nurseS, 'consultation:escalated');
    assert.equal((await emit(doc1S, 'consultation:decline', { consultationId: cid, reason: 'In clinic' })).ok, true);
    await Promise.all([d2, escalated]);
    const declined = once(nurseS, 'consultation:declined');
    assert.equal((await emit(doc2S, 'consultation:decline', { consultationId: cid })).ok, true);
    await declined;
    const c = await api('nurse1').get(`/consultations/${cid}`);
    assert.equal(c.body.consultation.status, 'DECLINED');
    assert.equal(c.body.consultation.routing.length, 2);
  });

  test('no answer: ring timeout escalates then expires', async () => {
    const pid = String(seedData.patients[1]._id);
    const expired = once(nurseS, 'consultation:expired', 15000);
    const r = await api('nurse1').post('/consultations', { patientId: pid, reason: 'Follow-up question on BP', urgency: 'ROUTINE' });
    assert.equal(r.status, 201);
    const ev = await expired;
    assert.equal(ev.reason, 'NO_ANSWER');
  });

  test('nurse can cancel a ringing request', async () => {
    const pid = String(seedData.patients[1]._id);
    const r = await api('nurse1').post('/consultations', { patientId: pid, reason: 'Quick question to cancel', urgency: 'ROUTINE' });
    const cancelled = once(doc1S, 'consultation:cancelled');
    const c = await emit(nurseS, 'consultation:cancel', { consultationId: r.body.consultation._id });
    assert.equal(c.ok, true);
    assert.equal(c.consultation.status, 'CANCELLED');
    await cancelled;
  });

  test('doctor unavailable when not accepting consultations', async () => {
    await api('doctor1').put('/me/availability', { acceptingConsultations: false });
    await api('doctor2').put('/me/availability', { acceptingConsultations: false });
    const r = await api('nurse1').post('/consultations', { patientId: String(seedData.patients[1]._id), reason: 'Nobody available test', urgency: 'URGENT' });
    assert.equal(r.status, 201);
    assert.equal(r.body.consultation.status, 'EXPIRED');
    assert.equal(r.body.consultation.failureReason, 'NO_DOCTOR_AVAILABLE');
    await api('doctor1').put('/me/availability', { acceptingConsultations: true });
  });

  test('peer drop: grace timer ends an unconnected call as FAILED', async () => {
    await api('doctor1').put('/me/availability', { acceptingConsultations: true });
    const pid = String(seedData.patients[1]._id);
    const req = once(doc1S, 'consultation:request');
    const r = await api('nurse1').post('/consultations', { patientId: pid, reason: 'Disconnect test', urgency: 'URGENT' });
    await req;
    const cid = r.body.consultation._id;
    await emit(doc1S, 'consultation:accept', { consultationId: cid });
    const tmpNurse = await connect('nurse1');
    await emit(tmpNurse, 'call:join', { consultationId: cid });
    await emit(doc1S, 'call:join', { consultationId: cid });
    const left = once(doc1S, 'call:peer-left');
    tmpNurse.disconnect();
    await left;
    await sleep(2600);
    const c = await api('admin').get(`/consultations/${cid}`);
    assert.equal(c.body.consultation.status, 'FAILED');
    assert.equal(c.body.consultation.failureReason, 'CONNECTION_LOST');
  });
});

/* ===================================================================== admin */

describe('admin operations', () => {
  test('suspending a user kills their existing token', async () => {
    const login = await request(base).post('/api/v1/auth/login').send({ identifier: 'nurse2@homecare.test', password: seedData.password });
    assert.equal(login.status, 200);
    const s = await api('admin').post(`/users/${seedData.nurse2._id}/status`, { status: 'SUSPENDED', reason: 'Credential expiry' });
    assert.equal(s.status, 200);
    const me = await request(base).get('/api/v1/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    assert.equal(me.status, 401);
    const relog = await request(base).post('/api/v1/auth/login').send({ identifier: 'nurse2@homecare.test', password: seedData.password });
    assert.equal(relog.status, 403);
    await api('admin').post(`/users/${seedData.nurse2._id}/status`, { status: 'ACTIVE' });
  });

  test('recurring schedule, overlap protection and visit completion feed billing', async () => {
    const start = new Date();
    start.setDate(start.getDate() + 7);
    start.setHours(15, 0, 0, 0);
    const until = new Date(start);
    until.setDate(until.getDate() + 13);
    const r = await api('admin').post('/visits', { patientId: String(seedData.patients[1]._id), nurseId: String(seedData.nurse1._id), start, durationMinutes: 60, recurrence: { daysOfWeek: [1, 3, 5], until } });
    assert.equal(r.status, 201);
    assert.ok(r.body.data.length >= 5);
    const clash = await api('admin').post('/visits', { patientId: String(seedData.patients[0]._id), nurseId: String(seedData.nurse1._id), start: r.body.data[0].scheduledStart, durationMinutes: 30 });
    assert.equal(clash.status, 409);

    const unassigned = await api('admin').post('/visits', { patientId: String(seedData.patients[2]._id), nurseId: String(seedData.nurse1._id), start, durationMinutes: 30 });
    assert.equal(unassigned.status, 400);

    const noCheckoutLocation = await api('nurse1').post(`/visits/${visitId}/complete`, { summary: 'Wound dressed; antibiotic started per doctor advice. Review tomorrow.' });
    assert.equal(noCheckoutLocation.status, 400, 'location is required to check out');
    const done = await api('nurse1').post(`/visits/${visitId}/complete`, { summary: 'Wound dressed; antibiotic started per doctor advice. Review tomorrow.', geo: { lat: 13.04, lng: 80.25, accuracy: 5 } });
    assert.equal(done.status, 200);
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const inv = await api('admin').post('/admin/invoices/generate', { patientId: String(seedData.patients[0]._id), from, to });
    assert.equal(inv.status, 201);
    assert.equal(inv.body.invoice.total, 900);
    const issue = await api('admin').post(`/admin/invoices/${inv.body.invoice._id}/issue`);
    assert.equal(issue.status, 200);
    const over = await api('admin').post(`/admin/invoices/${inv.body.invoice._id}/payments`, { amount: 5000, method: 'UPI' });
    assert.equal(over.status, 400);
    const pay = await api('admin').post(`/admin/invoices/${inv.body.invoice._id}/payments`, { amount: 900, method: 'UPI', reference: 'UPI-123' });
    assert.equal(pay.body.invoice.status, 'PAID');
    assert.equal((await api('patient1').get(`/patients/${seedData.patients[0]._id}/invoices`)).body.data.length, 1);
  });

  test('nurse attendance and leave workflow is reported to administrators', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const nurseAttendance = await api('nurse1').get(`/attendance?month=${month}`);
    assert.equal(nurseAttendance.status, 200);
    assert.ok(nurseAttendance.body.data.some((v) => v._id === visitId && v.checkIn?.at && v.checkOut?.at));
    const currentNurseAttendance = await api('nurse1').get('/attendance');
    assert.equal(currentNurseAttendance.status, 200);
    assert.equal(currentNurseAttendance.body.month, month);
    const adminAttendance = await api('admin').get(`/admin/attendance?month=${month}`);
    assert.equal(adminAttendance.status, 200);
    assert.ok(adminAttendance.body.data.some((v) => String(v._id) === visitId && v.checkIn?.at && v.checkOut?.at));
    assert.ok(adminAttendance.body.totals.some((n) => String(n.nurseId) === String(seedData.nurse1._id) && n.attendanceDays >= 1));
    const currentMonthAttendance = await api('admin').get('/admin/attendance');
    assert.equal(currentMonthAttendance.status, 200);
    assert.equal(currentMonthAttendance.body.month, month);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 40);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const day = (d) => d.toISOString().slice(0, 10);
    const requestLeave = await api('nurse1').post('/leaves', { startDate: day(startDate), endDate: day(endDate), type: 'ANNUAL', reason: 'Family responsibility' });
    assert.equal(requestLeave.status, 201);
    const leaveId = requestLeave.body.leave._id;
    const duplicateLeave = await api('nurse1').post('/leaves', { startDate: day(startDate), endDate: day(endDate), type: 'SICK', reason: 'Recovery time requested' });
    assert.equal(duplicateLeave.status, 409);

    const leaveMonth = day(startDate).slice(0, 7);
    const leaveReport = await api('admin').get(`/admin/leaves?month=${leaveMonth}&status=PENDING`);
    assert.ok(leaveReport.body.data.some((l) => l._id === leaveId));
    const approved = await api('admin').patch(`/admin/leaves/${leaveId}`, { status: 'APPROVED', reviewNote: 'Approved' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.leave.status, 'APPROVED');

    const scheduledDuringLeave = await api('admin').post('/visits', {
      patientId: String(seedData.patients[0]._id),
      nurseId: String(seedData.nurse1._id),
      start: new Date(startDate.setHours(12, 0, 0, 0)),
      durationMinutes: 30,
    });
    assert.equal(scheduledDuringLeave.status, 409);
    assert.equal(scheduledDuringLeave.body.error.code, 'NURSE_ON_LEAVE');
  });

  test('reports and exports', async () => {
    const s = await api('admin').get('/admin/reports/summary?period=monthly');
    assert.equal(s.status, 200);
    assert.ok(s.body.consultationsByStatus.COMPLETED >= 1);
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const csv = await api('admin').get(`/admin/reports/export?type=consultations&format=csv&from=${from}&to=${to}`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^Consultation,Requested/);
    const leaveCsv = await api('admin').get(`/admin/reports/export?type=leaves&format=csv&from=${from}&to=${to}`);
    assert.equal(leaveCsv.status, 200);
    assert.match(leaveCsv.text, /^Leave ID,Nurse/);
    const xlsx = await api('admin').get(`/admin/reports/export?type=visits&format=xlsx&from=${from}&to=${to}`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  });

  test('audit trail records clinical and admin actions and is append-only', async () => {
    const r = await api('admin').get('/admin/audit?limit=200');
    const actions = new Set(r.body.data.map((a) => a.action));
    for (const a of ['LOGIN', 'PATIENT_VIEW', 'VISIT_START', 'CONSULT_REQUEST', 'ADVICE_SIGN', 'ADVICE_AMEND', 'USER_STATUS_CHANGE', 'REPORT_EXPORT', 'CAREGIVER_REVOKE']) {
      assert.ok(actions.has(a), `missing audit action ${a}`);
    }
    const { AuditLog } = await import('../src/models/index.js');
    await assert.rejects(AuditLog.updateOne({}, { action: 'TAMPER' }));
  });

  test('file upload requires photo consent and checks content type', async () => {
    const pid = String(seedData.patients[1]._id);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5f50000000049454e44ae426082', 'hex');
    const auth = { Authorization: `Bearer ${tokens.nurse1.accessToken}` };
    const noConsent = await request(base).post(`/api/v1/patients/${pid}/files`).set(auth).field('category', 'CLINICAL_PHOTO').attach('file', png, { filename: 'w.png', contentType: 'image/png' });
    assert.equal(noConsent.status, 400);
    const fake = await request(base).post(`/api/v1/patients/${pid}/files`).set(auth).field('category', 'LAB_REPORT').attach('file', Buffer.from('not a pdf at all'), { filename: 'x.pdf', contentType: 'application/pdf' });
    assert.equal(fake.status, 400);
    const ok = await request(base).post(`/api/v1/patients/${pid}/files`).set(auth).field('category', 'CLINICAL_PHOTO').field('consentConfirmed', 'true').attach('file', png, { filename: 'w.png', contentType: 'image/png' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const dl = await request(base).get(`/api/v1/files/${ok.body.file._id}`).set(auth);
    assert.equal(dl.status, 200);
    const other = await request(base).get(`/api/v1/files/${ok.body.file._id}`).set('Authorization', `Bearer ${tokens.doctor2.accessToken}`);
    assert.equal(other.status, 403);
  });
});

describe('signed document links', () => {
  test('link works once issued, expires, and requires access', async () => {
    const { FileObject } = await import('../src/models/index.js');
    const f = await FileObject.findOne({ category: 'CLINICAL_PHOTO' });
    assert.equal((await api('doctor2').post(`/files/${f._id}/link`)).status, 403);
    const link = await api('nurse1').post(`/files/${f._id}/link`);
    assert.equal(link.status, 200);
    const dl = await request(base).get(link.body.url);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'image/png');
    assert.equal((await request(base).get('/api/v1/files/download/not-a-token')).status, 403);
  });
});

describe('web client cookie sessions', () => {
  test('admin portal gets httpOnly refresh cookie, never a body token', async () => {
    const agent = request.agent(base);
    const login = await agent.post('/api/v1/auth/login').set('X-Client', 'web').send({ identifier: 'admin@homecare.test', password: seedData.password, portal: 'admin' });
    assert.equal(login.status, 200);
    assert.equal(login.body.refreshToken, undefined);
    const cookie = login.headers['set-cookie'].join(';');
    assert.match(cookie, /hc_rt=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const r = await agent.post('/api/v1/auth/refresh').set('X-Client', 'web').send({});
    assert.equal(r.status, 200);
    assert.ok(r.body.accessToken);
    const noHeader = await agent.post('/api/v1/auth/refresh').send({});
    assert.equal(noHeader.status, 401, 'cookie only honoured with the X-Client header (CSRF guard)');
  });
});
