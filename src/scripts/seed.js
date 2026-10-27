/**
 * Development seed. Refuses to run in staging/production.
 *   SEED_PASSWORD=YourDevPass123 npm run seed
 */
import { env, isProd } from '../config/env.js';
import { connectDb, disconnectDb } from '../config/db.js';
import {
  Assignment, CaregiverLink, CarePlan, CareService, Patient, ServiceCategory, User, Visit, nextSequence,
} from '../models/index.js';
import { hashPassword } from '../routes/auth.js';
import { ROLES } from '../utils/constants.js';

if (isProd) {
  console.error('Seeding is disabled outside development.');
  process.exit(1);
}

export async function seed({ reset = true, password = process.env.SEED_PASSWORD || 'DevPass12345' } = {}) {
  if (reset) {
    const { connection } = await import('mongoose').then((m) => m.default);
    await connection.db.dropDatabase();
  }
  const passwordHash = await hashPassword(password);
  const mk = (o) => User.create({ passwordHash, status: 'ACTIVE', ...o });

  const admin = await mk({ role: ROLES.ADMIN, email: 'admin@homecare.test', mobile: '+919000000001', name: { first: 'Asha', last: 'Admin' }, employeeId: 'ADM-001' });
  const nurse1 = await mk({
    role: ROLES.NURSE, email: 'nurse1@homecare.test', mobile: '+919000000011', name: { first: 'Priya', last: 'Raman' }, employeeId: 'NUR-001',
    professional: { registrationNumber: 'TNNMC-12345', registrationCouncil: 'Tamil Nadu Nurses & Midwives Council', qualifications: [{ title: 'B.Sc Nursing', institution: 'Madras Medical College', year: 2016 }], specializations: ['Geriatric care', 'Wound care'], verificationStatus: 'VERIFIED', languages: ['Tamil', 'English'] },
  });
  const nurse2 = await mk({
    role: ROLES.NURSE, email: 'nurse2@homecare.test', mobile: '+919000000012', name: { first: 'Joseph', last: 'Mathew' }, employeeId: 'NUR-002',
    professional: { registrationNumber: 'KNC-55421', registrationCouncil: 'Kerala Nurses Council', specializations: ['Post-operative care'], verificationStatus: 'VERIFIED' },
  });
  const doctor1 = await mk({
    role: ROLES.DOCTOR, email: 'doctor1@homecare.test', mobile: '+919000000021', name: { first: 'Dr. Karthik', last: 'Subramanian' }, employeeId: 'DOC-001',
    professional: { registrationNumber: 'TNMC-98765', registrationCouncil: 'Tamil Nadu Medical Council', qualifications: [{ title: 'MBBS' }, { title: 'MD (Internal Medicine)' }], specializations: ['Internal Medicine', 'Geriatrics'], verificationStatus: 'VERIFIED', canPrescribe: true, languages: ['Tamil', 'English'] },
    availability: { acceptingConsultations: true, weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '18:00' })) },
  });
  const doctor2 = await mk({
    role: ROLES.DOCTOR, email: 'doctor2@homecare.test', mobile: '+919000000022', name: { first: 'Dr. Meera', last: 'Iyer' }, employeeId: 'DOC-002',
    professional: { registrationNumber: 'TNMC-45678', registrationCouncil: 'Tamil Nadu Medical Council', qualifications: [{ title: 'MBBS' }], specializations: ['Family Medicine'], verificationStatus: 'VERIFIED', canPrescribe: false },
    availability: { acceptingConsultations: true },
  });
  const patientUser = await mk({ role: ROLES.PATIENT, email: 'patient1@homecare.test', mobile: '+919000000031', name: { first: 'Lakshmi', last: 'Narayanan' } });
  const caregiver = await mk({ role: ROLES.PATIENT, email: 'family1@homecare.test', mobile: '+919000000032', name: { first: 'Ravi', last: 'Narayanan' } });

  const nursing = await ServiceCategory.create({ name: 'Nursing care', description: 'Skilled nursing at home' });
  const elder = await ServiceCategory.create({ name: 'Elder care', description: 'Long-term care for seniors' });
  const physio = await ServiceCategory.create({ name: 'Physiotherapy' });
  const svcVisit = await CareService.create({ categoryId: nursing._id, name: 'Nursing visit (60 min)', defaultDurationMinutes: 60, price: 1200, taxPercent: 0 });
  const svcWound = await CareService.create({ categoryId: nursing._id, name: 'Wound dressing', defaultDurationMinutes: 45, price: 900 });
  await CareService.create({ categoryId: elder._id, name: 'Elder care assessment', defaultDurationMinutes: 90, price: 1800 });
  await CareService.create({ categoryId: physio._id, name: 'Physiotherapy session', defaultDurationMinutes: 45, price: 1000, taxPercent: 18 });

  const p1 = await Patient.create({
    patientCode: await nextSequence('patient', 'HC-'), userId: patientUser._id, name: { first: 'Lakshmi', last: 'Narayanan' },
    dateOfBirth: new Date('1948-03-12'), gender: 'Female', bloodGroup: 'B+', phone: '+919000000031',
    address: { line1: '12, 3rd Cross Street', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600020', geo: { lat: 13.04, lng: 80.25 } },
    emergencyContacts: [{ name: 'Ravi Narayanan', relation: 'Son', phone: '+919000000032', isPrimary: true }],
    allergies: [{ substance: 'Penicillin', reaction: 'Rash', severity: 'MODERATE' }],
    currentMedications: [{ name: 'Metformin', dose: '500 mg', route: 'Oral', frequency: 'BD' }, { name: 'Amlodipine', dose: '5 mg', route: 'Oral', frequency: 'OD' }],
    medicalHistory: [{ condition: 'Type 2 diabetes', since: '2010' }, { condition: 'Hypertension', since: '2012' }],
    primaryDiagnosis: 'Diabetic foot ulcer, right heel', mobilityStatus: 'Walks with support',
    assignedDoctorId: doctor1._id,
    consents: [{ type: 'TREATMENT', granted: true, method: 'WRITTEN', recordedBy: admin._id }, { type: 'TELECONSULTATION', granted: true, method: 'WRITTEN', recordedBy: admin._id }, { type: 'DATA_SHARING_FAMILY', granted: true, method: 'WRITTEN', recordedBy: admin._id }],
    createdBy: admin._id,
  });
  const p2 = await Patient.create({
    patientCode: await nextSequence('patient', 'HC-'), name: { first: 'Abdul', last: 'Rahman' }, dateOfBirth: new Date('1955-09-01'), gender: 'Male',
    address: { line1: '45 Anna Salai', city: 'Chennai', postalCode: '600002' },
    allergies: [], currentMedications: [{ name: 'Atorvastatin', dose: '20 mg', frequency: 'HS' }],
    medicalHistory: [{ condition: 'Post CABG (2025)' }], primaryDiagnosis: 'Post-operative cardiac rehabilitation', createdBy: admin._id,
  });
  const p3 = await Patient.create({
    patientCode: await nextSequence('patient', 'HC-'), name: { first: 'Saroja', last: 'Devi' }, dateOfBirth: new Date('1940-01-20'), gender: 'Female',
    address: { line1: '8 Lake View Road', city: 'Chennai' }, primaryDiagnosis: 'Parkinson disease', createdBy: admin._id,
  });

  await CaregiverLink.create({ patientId: p1._id, caregiverUserId: caregiver._id, relation: 'Son', permissions: ['VIEW_PROFILE', 'VIEW_APPOINTMENTS', 'VIEW_SUMMARIES', 'VIEW_CARE_PLAN'], grantedBy: admin._id });
  await Assignment.create({ patientId: p1._id, nurseId: nurse1._id, assignedBy: admin._id });
  await Assignment.create({ patientId: p2._id, nurseId: nurse1._id, assignedBy: admin._id });
  await Assignment.create({ patientId: p3._id, nurseId: nurse2._id, assignedBy: admin._id });

  const plan = await CarePlan.create({
    patientId: p1._id, title: 'Diabetic foot ulcer management',
    goals: [{ description: 'Wound size reduction by 50% in 4 weeks' }, { description: 'Fasting glucose under 130 mg/dL' }],
    interventions: [{ description: 'Alternate-day wound dressing', frequency: 'Alternate days' }, { description: 'Capillary glucose monitoring', frequency: 'Each visit' }],
    services: [{ serviceId: svcWound._id, frequency: 'Alternate days' }, { serviceId: svcVisit._id, frequency: 'Weekly' }],
    precautions: ['Penicillin allergy', 'Fall risk'], startDate: new Date(), createdBy: admin._id,
  });

  const today = (h, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };
  await Visit.create([
    { patientId: p1._id, nurseId: nurse1._id, serviceId: svcWound._id, carePlanId: plan._id, scheduledStart: today(9), scheduledEnd: today(9, 45), createdBy: admin._id },
    { patientId: p2._id, nurseId: nurse1._id, serviceId: svcVisit._id, scheduledStart: today(11), scheduledEnd: today(12), createdBy: admin._id },
    { patientId: p3._id, nurseId: nurse2._id, serviceId: svcVisit._id, scheduledStart: today(10), scheduledEnd: today(11), createdBy: admin._id },
    { patientId: p1._id, nurseId: nurse1._id, serviceId: svcWound._id, carePlanId: plan._id, scheduledStart: new Date(today(9).getTime() + 2 * 86400000), scheduledEnd: new Date(today(9, 45).getTime() + 2 * 86400000), createdBy: admin._id },
  ]);

  return { admin, nurse1, nurse2, doctor1, doctor2, patientUser, caregiver, patients: [p1, p2, p3], password };
}

if (process.argv[1]?.endsWith('seed.js')) {
  await connectDb(env.MONGODB_URI);
  const r = await seed();
  console.log(`Seeded. Password for all accounts: ${r.password}`);
  console.log('admin@homecare.test, nurse1@homecare.test, nurse2@homecare.test, doctor1@homecare.test, doctor2@homecare.test, patient1@homecare.test, family1@homecare.test');
  await disconnectDb();
}
