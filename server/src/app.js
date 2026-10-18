import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { config as defaultConfig } from './config/env.js';
import { createLimiters } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { mongoSanitize } from './utils/sanitize.js';
import { mediaRoutes, hlsStaticRoute } from './routes/media.js';
import { createMediaService } from './services/media/index.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { broadcastRoutes } from './routes/broadcasts.js';
import { emergencyRoutes } from './routes/emergency.js';
import { aiRoutes, alertRoutes, analyticsRoutes, networkRoutes } from './routes/misc.js';
import { createAnalysisCache } from './services/analysisCache.js';
import { createAccountService } from './services/auth/accounts.js';
import { createMongoAccountRepos } from './services/auth/accountRepos.js';
import { createHasher } from './services/auth/passwords.js';
import { createMailer } from './services/auth/mailer.js';

/**
 * Express app factory. Dependencies are injected so tests can run the real middleware stack
 * (auth, validation, rate limits, sanitisation, error handling) without a database or Groq.
 *
 * @param {{ config?: typeof defaultConfig, ai: object, signer: object, realtime: object, limiters?: object, repos?: object, mailer?: object, accounts?: object, media?: object }} deps
 */
export function createApp({
  config = defaultConfig,
  ai,
  signer,
  realtime,
  limiters = createLimiters(config.rateLimit),
  repos = createMongoAccountRepos(),
  mailer = createMailer(config.mail),
  accounts = createAccountService({ repos, config, mailer, hasher: createHasher(config.auth.argon2) }),
  media = createMediaService({ config }),
}) {
  const app = express();
  const startedAt = Date.now();

  app.locals.config = config;
  app.locals.audit = (type, req, extra = {}) => repos.audit.record({ type, at: Date.now(), ip: req.ip ?? null, userAgent: req.get?.('user-agent') ?? null, actorId: req.user?.id ?? null, targetId: extra.targetId ?? null, meta: extra.meta ?? null }).catch(() => {});
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / non-browser clients (curl, health pings) send no Origin header.
        if (!origin || config.clientOrigins.includes(origin.replace(/\/$/, ''))) return cb(null, true);
        cb(new Error('CORS_NOT_ALLOWED'));
      },
      // credentials: the httpOnly refresh cookie. Only allowlisted origins are ever echoed (never '*').
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-ZS-CSRF'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  app.use(mongoSanitize);
  app.use('/api', limiters.general);

  // Cheap public health check — used by clients to detect and wake a sleeping Render instance.
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      status: 'ok',
      service: 'zerosignal-api',
      time: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      db: mongoose.connection.readyState === 1 ? 'up' : 'down',
    });
  });

  const analysisCache = createAnalysisCache();
  app.use('/api/auth', authRoutes({ config, limiters, accounts }));
  app.use('/api/broadcasts', broadcastRoutes({ realtime, media, audit: (t, req, x) => app.locals.audit(t, req, x) }));
  app.use('/api/media', mediaRoutes({ media, audit: (type, req, extra) => app.locals.audit(type, req, extra) }));
  app.use('/media/hls', hlsStaticRoute({ media, config }));
  app.use('/api/emergency', emergencyRoutes({ ai, signer, realtime, analysisCache, limiters, audit: (t, req, x) => app.locals.audit(t, req, x) }));
  app.use('/api/ai', aiRoutes({ ai, limiters }));
  app.use('/api/alerts', alertRoutes({ signer }));
  app.use('/api/network', networkRoutes());
  app.use('/api/analytics', analyticsRoutes());
  app.use('/api/admin', adminRoutes({ config, ai, realtime, startedAt, limiters, accounts, repos, media }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
