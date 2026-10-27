import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import mongoose from 'mongoose';
import { corsOrigins, env, isProd } from './config/env.js';
import { logger } from './config/logger.js';
import { requireAuth } from './middleware/auth.js';
import { apiLimiter, errorHandler, notFoundHandler, requestId } from './middleware/common.js';
import { openapi } from './docs/openapi.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import userRoutes from './routes/users.js';
import patientRoutes from './routes/patients.js';
import visitRoutes from './routes/visits.js';
import careRoutes from './routes/care.js';
import consultationRoutes from './routes/consultations.js';
import fileRoutes, { publicFileRouter } from './routes/files.js';
import { adminRouter, dashboardRouter, notificationsRouter } from './routes/admin.js';
import nurseOperationsRoutes from './routes/nurseOperations.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() }));

  if (!isProd || process.env.ENABLE_SWAGGER === 'true') {
    app.get('/api/docs/openapi.json', (_req, res) => res.json(openapi));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'HomeCare API' }));
  }

  const v1 = express.Router();
  v1.use(apiLimiter);
  v1.use('/auth', authRoutes);
  v1.use('/', publicFileRouter);
  // Everything below requires a valid access token
  v1.use(requireAuth);
  v1.use('/me', meRoutes);
  v1.use('/users', userRoutes);
  v1.use('/patients', patientRoutes);
  v1.use('/visits', visitRoutes);
  v1.use('/care', careRoutes);
  v1.use('/consultations', consultationRoutes);
  v1.use('/notifications', notificationsRouter);
  v1.use('/dashboard', dashboardRouter);
  v1.use('/', nurseOperationsRoutes);
  v1.use('/admin', adminRouter);
  v1.use('/', fileRoutes);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
