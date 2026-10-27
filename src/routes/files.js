import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { FileObject, User } from '../models/index.js';
import { idParam, objectId, validate } from '../middleware/common.js';
import { isClinical, isPatientSide, requirePatientSidePermission, resolvePatientAccess } from '../services/accessService.js';
import { audit } from '../services/auditService.js';
import { ROLES } from '../utils/constants.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';

/**
 * Local-disk storage for development. In production swap `storeFile`/`openFile` for an
 * encrypted object store (e.g. S3 with SSE-KMS) and serve via short-lived signed URLs.
 */
const UPLOAD_ROOT = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/heic', '.heic'],
  ['application/pdf', '.pdf'],
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(badRequest('Only JPEG, PNG, HEIC or PDF files are allowed'))),
});

/** Check magic bytes rather than trusting the client-supplied MIME type. */
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf.subarray(4, 12).toString().startsWith('ftyphei') || buf.subarray(4, 12).toString().startsWith('ftypmif1')) return 'image/heic';
  return null;
}

async function storeFile(buffer, mime) {
  const key = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ALLOWED.get(mime)}`;
  const full = path.join(UPLOAD_ROOT, key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, buffer, { mode: 0o600 });
  return key;
}

const router = Router();

router.post(
  '/patients/:id/files',
  upload.single('file'),
  validate({
    params: idParam,
    body: z.object({
      category: z.enum(['CLINICAL_PHOTO', 'LAB_REPORT', 'PRESCRIPTION', 'DISCHARGE_SUMMARY', 'ID_PROOF', 'OTHER']),
      title: z.string().max(200).optional(),
      visitId: objectId.optional(),
      consultationId: objectId.optional(),
      consentConfirmed: z.enum(['true', 'false']).optional(),
      visibility: z.enum(['CLINICAL_TEAM', 'PATIENT_AND_FAMILY', 'ADMIN_ONLY']).optional(),
    }),
  }),
  async (req, res) => {
    if (!req.file) throw badRequest('file is required');
    const ctx = await resolvePatientAccess(req.user, req.params.id);
    if (!['ADMIN', 'ASSIGNED_NURSE', 'ASSIGNED_DOCTOR', 'CONSULTING_DOCTOR', 'SELF'].includes(ctx.relation)) throw forbidden('You cannot upload documents for this patient');
    const mime = sniff(req.file.buffer);
    if (!mime || mime !== req.file.mimetype) throw badRequest('File content does not match its type');

    const consent = req.body.consentConfirmed === 'true';
    if (req.body.category === 'CLINICAL_PHOTO') {
      if (!(ctx.patient.hasConsent('CLINICAL_PHOTOS') || consent)) throw badRequest('Patient consent is required for clinical photographs');
      if (!ctx.patient.hasConsent('CLINICAL_PHOTOS')) {
        ctx.patient.consents.push({ type: 'CLINICAL_PHOTOS', granted: true, method: 'VERBAL', recordedBy: req.user._id });
        await ctx.patient.save();
      }
    }
    let visibility = req.body.visibility || (ctx.relation === 'SELF' ? 'PATIENT_AND_FAMILY' : 'CLINICAL_TEAM');
    if (visibility === 'ADMIN_ONLY' && ctx.relation !== 'ADMIN') visibility = 'CLINICAL_TEAM';

    const storageKey = await storeFile(req.file.buffer, mime);
    const doc = await FileObject.create({
      ownerType: 'PATIENT',
      patientId: ctx.patient._id,
      visitId: req.body.visitId,
      consultationId: req.body.consultationId,
      category: req.body.category,
      title: req.body.title || req.file.originalname?.slice(0, 200),
      storageKey,
      mimeType: mime,
      sizeBytes: req.file.size,
      sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
      consentConfirmed: consent || undefined,
      visibility,
      uploadedBy: req.user._id,
    });
    await audit(req, 'FILE_UPLOAD', 'FileObject', doc._id, undefined, { patientId: String(ctx.patient._id), category: doc.category });
    const out = doc.toObject();
    delete out.storageKey;
    res.status(201).json({ file: out });
  },
);

/** Staff credential uploads (registration certificate etc.) by admin or the staff member. */
router.post(
  '/users/:id/credentials',
  upload.single('file'),
  validate({ params: idParam, body: z.object({ kind: z.string().min(2).max(60) }) }),
  async (req, res) => {
    if (!req.file) throw badRequest('file is required');
    if (req.user.role !== ROLES.ADMIN && String(req.user._id) !== req.params.id) throw forbidden();
    const user = await User.findById(req.params.id);
    if (!user || ![ROLES.NURSE, ROLES.DOCTOR].includes(user.role)) throw notFound('Staff member not found');
    const mime = sniff(req.file.buffer);
    if (!mime || mime !== req.file.mimetype) throw badRequest('File content does not match its type');
    const storageKey = await storeFile(req.file.buffer, mime);
    const doc = await FileObject.create({ ownerType: 'USER', userId: user._id, category: 'CREDENTIAL', title: req.body.kind, storageKey, mimeType: mime, sizeBytes: req.file.size, visibility: 'ADMIN_ONLY', uploadedBy: req.user._id });
    user.professional ??= {};
    user.professional.documents.push({ kind: req.body.kind, fileId: doc._id, status: 'PENDING' });
    if (user.professional.verificationStatus === 'UNVERIFIED') user.professional.verificationStatus = 'PENDING';
    await user.save();
    await audit(req, 'CREDENTIAL_UPLOAD', 'User', user._id, undefined, { kind: req.body.kind });
    res.status(201).json({ documents: user.professional.documents });
  },
);

async function authorizeFileAccess(user, fileId) {
  const doc = await FileObject.findOne({ _id: fileId, deletedAt: null }).select('+storageKey');
  if (!doc) throw notFound('File not found');
  if (doc.ownerType === 'USER') {
    if (user.role !== ROLES.ADMIN && !doc.userId.equals(user._id)) throw forbidden();
  } else {
    const ctx = await resolvePatientAccess(user, doc.patientId);
    if (isPatientSide(ctx)) {
      requirePatientSidePermission(ctx, 'VIEW_DOCUMENTS');
      if (doc.visibility !== 'PATIENT_AND_FAMILY') throw forbidden();
    } else if (isClinical(ctx) && ctx.relation !== 'ADMIN' && doc.visibility === 'ADMIN_ONLY') throw forbidden();
  }
  return doc;
}

function streamFile(res, doc) {
  const full = path.join(UPLOAD_ROOT, doc.storageKey);
  if (!full.startsWith(UPLOAD_ROOT) || !fs.existsSync(full)) throw notFound('File content missing');
  res.set({
    'Content-Type': doc.mimeType,
    'Content-Disposition': `inline; filename="${encodeURIComponent(doc.title || 'document')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
}

router.get('/files/:id', validate({ params: idParam }), async (req, res) => {
  const doc = await authorizeFileAccess(req.user, req.params.id);
  await audit(req, 'FILE_DOWNLOAD', 'FileObject', doc._id);
  streamFile(res, doc);
});

/**
 * Short-lived (60 s) signed link so a phone can open a document in the system viewer
 * without putting the access token in a URL.
 */
router.post('/files/:id/link', validate({ params: idParam }), async (req, res) => {
  const doc = await authorizeFileAccess(req.user, req.params.id);
  const token = jwt.sign({ fid: String(doc._id), sub: String(req.user._id), purpose: 'file' }, env.JWT_ACCESS_SECRET, { expiresIn: 60, audience: 'file-download', algorithm: 'HS256' });
  await audit(req, 'FILE_LINK_ISSUED', 'FileObject', doc._id);
  res.json({ url: `/api/v1/files/download/${token}`, expiresIn: 60 });
});

export default router;

/** Public router (mounted before auth) that redeems signed download links. */
export const publicFileRouter = Router();
publicFileRouter.get('/files/download/:token', async (req, res) => {
  let claims;
  try {
    claims = jwt.verify(req.params.token, env.JWT_ACCESS_SECRET, { audience: 'file-download', algorithms: ['HS256'] });
  } catch {
    throw forbidden('Link expired');
  }
  if (claims.purpose !== 'file') throw forbidden();
  const doc = await FileObject.findOne({ _id: claims.fid, deletedAt: null }).select('+storageKey');
  if (!doc) throw notFound('File not found');
  await audit({ ip: req.ip, id: req.id, get: (h) => req.get(h), user: { _id: claims.sub } }, 'FILE_DOWNLOAD', 'FileObject', doc._id, undefined, { via: 'signed-link' });
  streamFile(res, doc);
});
