import { logger } from './config/logger.js';
import { sweepExpiredRings } from './services/consultationService.js';
import { markMissedVisits } from './routes/visits.js';
import { Consultation } from './models/index.js';
import { CONSULT_STATUS } from './utils/constants.js';

/**
 * Lightweight in-process jobs. With several API instances, run these in exactly one
 * (e.g. a dedicated worker, or guard with a Mongo/Redis lock).
 */
export function startJobs() {
  const timers = [];
  const every = (ms, name, fn) => {
    const t = setInterval(() => fn().catch((err) => logger.error({ err, job: name }, 'job failed')), ms);
    t.unref();
    timers.push(t);
  };

  every(15_000, 'ring-sweeper', sweepExpiredRings);
  every(10 * 60_000, 'missed-visits', async () => {
    const r = await markMissedVisits();
    if (r.modifiedCount) logger.info({ count: r.modifiedCount }, 'Visits marked missed');
  });
  // Accepted calls that never connected (both apps died) are closed after 10 minutes.
  every(60_000, 'stale-accepted', async () => {
    const r = await Consultation.updateMany(
      { status: CONSULT_STATUS.ACCEPTED, acceptedAt: { $lt: new Date(Date.now() - 10 * 60_000) } },
      { status: CONSULT_STATUS.FAILED, failureReason: 'NEVER_CONNECTED', endedAt: new Date(), durationSeconds: 0 },
    );
    if (r.modifiedCount) logger.warn({ count: r.modifiedCount }, 'Stale accepted consultations closed');
  });

  return () => timers.forEach(clearInterval);
}
