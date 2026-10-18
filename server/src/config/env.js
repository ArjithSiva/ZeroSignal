/**
 * Environment configuration. Parsed once, validated, and frozen.
 * `node --env-file-if-exists=.env` loads `.env` (see package.json scripts); no dotenv needed.
 */

const DEV_JWT_SECRET = 'dev-only-jwt-secret-do-not-use-in-production';
// sha256('zerosignal-dev-only-signing-seed') — public, so never trust it. Only used when NODE_ENV !== 'production'.
const DEV_SIGNING_SEED = '54f2fd3d72f49c775910a7e56d9225b806854e7bb3d2167b60ed9eb175f9c471';

/** Dashboards make it easy to paste a trailing space or surrounding quotes; neither is part of the value. */
const clean = (v) => (v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

const toInt = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const toBool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const csv = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Build a config object from an env-like map. Exported for tests.
 * @param {Record<string, string|undefined>} [env]
 */
export function loadConfig(rawEnv = process.env) {
  const env = { ...rawEnv };
  for (const k of ['JWT_SECRET', 'ALERT_SIGNING_SEED', 'MONGODB_URI', 'CLIENT_ORIGINS']) if (env[k] != null) env[k] = clean(env[k]);
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const warnings = [];

  const jwtSecret = env.JWT_SECRET || (isProd ? '' : DEV_JWT_SECRET);
  const signingSeed = env.ALERT_SIGNING_SEED || (isProd ? '' : DEV_SIGNING_SEED);

  const missing = [];
  if (isProd) {
    if (!env.MONGODB_URI) missing.push('MONGODB_URI');
    if (!jwtSecret) missing.push('JWT_SECRET');
    if (!signingSeed) missing.push('ALERT_SIGNING_SEED');
    if (!env.CLIENT_ORIGINS) missing.push('CLIENT_ORIGINS');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables for production: ${missing.join(', ')}`);
  }
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  if (!/^[0-9a-fA-F]{64}$/.test(signingSeed)) throw new Error(`ALERT_SIGNING_SEED must be exactly 64 hex characters (0-9, a-f), but it has ${signingSeed.length}. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);

  if (!env.JWT_SECRET) warnings.push('JWT_SECRET not set — using an insecure development secret.');
  if (!env.ALERT_SIGNING_SEED) warnings.push('ALERT_SIGNING_SEED not set — using an insecure development signing key.');
  if (!env.GROQ_API_KEY) warnings.push('GROQ_API_KEY not set — AI runs in rule-based fallback mode.');

  const origins = (env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  // ── mail ──
  const mailTransport = (env.MAIL_TRANSPORT || (env.SMTP_URL ? 'smtp' : 'console')).toLowerCase();
  if (!['console', 'smtp', 'memory'].includes(mailTransport)) throw new Error('MAIL_TRANSPORT must be console, smtp or memory');
  if (mailTransport === 'smtp' && !env.SMTP_URL) throw new Error('MAIL_TRANSPORT=smtp needs SMTP_URL');
  if (isProd && mailTransport === 'console') warnings.push('MAIL_TRANSPORT=console in production — password-reset and invite links are only printed to the server log. Set SMTP_URL.');

  // ── cookies (refresh token) ──
  const sameSite = (env.COOKIE_SAMESITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict or none');
  if (sameSite === 'none' && !isProd && !toBool(env.COOKIE_SECURE, false)) warnings.push('COOKIE_SAMESITE=none needs HTTPS (Secure cookies); it will not work over plain http.');

  // ── media (streaming) ──
  const media = {
    /** Provider preference order. `simulated` is always appended as the last resort. */
    providers: csv(env.MEDIA_PROVIDERS || 'livekit,hls,simulated'),
    livekit: {
      url: env.LIVEKIT_URL || '',
      apiKey: env.LIVEKIT_API_KEY || '',
      apiSecret: env.LIVEKIT_API_SECRET || '',
      tokenTtlSec: toInt(env.LIVEKIT_TOKEN_TTL_SEC, 3600),
    },
    hls: {
      /** Public base URL where segments are served (CDN/object storage). Empty = serve from this API (dev/demo only). */
      baseUrl: (env.HLS_BASE_URL || '').replace(/\/$/, ''),
      outputDir: env.HLS_OUTPUT_DIR || '',
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      sourceFile: env.HLS_SOURCE_FILE || '',
    },
    /** Rooms are named from an HMAC of the broadcast id, so they are unguessable. */
    roomSalt: env.MEDIA_ROOM_SALT || jwtSecret,
  };

  return Object.freeze({
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port: toInt(env.PORT, 5000),
    mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/zerosignal',
    mongoUriConfigured: Boolean(env.MONGODB_URI),
    jwtSecret,
    /** Short-lived access token. (JWT_EXPIRES_IN is honoured as a legacy alias.) */
    accessTokenTtl: env.ACCESS_TOKEN_TTL || env.JWT_EXPIRES_IN || '15m',
    jwtExpiresIn: env.ACCESS_TOKEN_TTL || env.JWT_EXPIRES_IN || '15m',
    signingSeed: signingSeed.toLowerCase(),
    clientOrigins: origins,
    /** Where links in emails point (reset / invite). Defaults to the first allowed client origin. */
    appBaseUrl: (env.APP_BASE_URL || origins[0] || 'http://localhost:5173').replace(/\/$/, ''),
    trustProxy: toInt(env.TRUST_PROXY, 0),
    auth: {
      refreshTtlDays: toInt(env.REFRESH_TTL_DAYS, 30),
      cookieName: 'zs_rt',
      cookieSameSite: sameSite,
      cookieSecure: toBool(env.COOKIE_SECURE, isProd),
      /** OWASP-recommended argon2id baseline; lowered in tests via ARGON2_* only. */
      argon2: { memoryCost: toInt(env.ARGON2_MEMORY_KIB, 19_456), timeCost: toInt(env.ARGON2_TIME_COST, 2), parallelism: 1 },
      lockout: { threshold: toInt(env.LOCKOUT_THRESHOLD, 5), baseMinutes: toInt(env.LOCKOUT_BASE_MINUTES, 1), maxMinutes: toInt(env.LOCKOUT_MAX_MINUTES, 30) },
      resetTtlMinutes: toInt(env.RESET_TTL_MINUTES, 30),
      inviteTtlHours: toInt(env.INVITE_TTL_HOURS, 72),
      auditRetentionDays: toInt(env.AUDIT_RETENTION_DAYS, 365),
    },
    mail: { transport: mailTransport, smtpUrl: env.SMTP_URL || '', from: env.MAIL_FROM || 'ZeroSignal <no-reply@localhost>' },
    media,
    groq: {
      apiKey: env.GROQ_API_KEY || '',
      model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      timeoutMs: toInt(env.GROQ_TIMEOUT_MS, 8000),
      baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    },
    rateLimit: {
      windowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: toInt(env.RATE_LIMIT_MAX, 300),
      authMax: toInt(env.RATE_LIMIT_AUTH_MAX, 20),
      aiMax: toInt(env.RATE_LIMIT_AI_MAX, 20),
    },
    warnings,
  });
}

export const config = loadConfig();
