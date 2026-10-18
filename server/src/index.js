import http from 'node:http';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { config } from './config/env.js';
import { createApp } from './app.js';
import { createAiService } from './services/ai.js';
import { createGroqClient } from './services/groq.js';
import { getSigner } from './services/signing.js';
import { createMongoStore } from './services/store.js';
import { createMediaService } from './services/media/index.js';
import { createRealtime } from './sockets/realtime.js';
import { AiUsage } from './models/index.js';
import { runBootstrap } from './bootstrap.js';

for (const w of config.warnings) console.warn(`⚠ ${w}`);

// A stray rejected promise (a socket handler, a mail send) must never take a live broadcast down.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const signer = getSigner();
const groq = createGroqClient(config.groq);
const ai = createAiService(groq, {
  recordUsage: async (u) => {
    if (mongoose.connection.readyState === 1) await AiUsage.create(u);
  },
});

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigins, methods: ['GET', 'POST'] },
  // WebSocket first, long-polling fallback: works across Vercel ↔ Render and corporate proxies.
  transports: ['websocket', 'polling'],
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 64 * 1024,
});
const realtime = createRealtime({ io, store: createMongoStore() });
realtime.attach();

const media = createMediaService({ config });
const app = createApp({ config, ai, signer, realtime, media });
httpServer.on('request', app);

// The server starts listening immediately, even if MongoDB is slow or down: /api/health reports
// db: "down" and the client shows its "waking server" state instead of a connection error.
// Fail fast (instead of hanging ~10 s) when a route needs the DB before it is connected.
mongoose.set('bufferTimeoutMS', 4000);

async function connectMongo(attempt = 1) {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
    console.log(`✔ MongoDB connected (${mongoose.connection.name})`);
    runBootstrap({ config }); // first admin / optional sample history from env vars (no shell needed)
  } catch (err) {
    const wait = Math.min(30_000, 2000 * attempt);
    console.error(`✖ MongoDB connection failed (${err.message}). Retrying in ${wait / 1000}s…`);
    if (!config.mongoUriConfigured) console.error('  Set MONGODB_URI in server/.env (see .env.example).');
    setTimeout(() => connectMongo(attempt + 1), wait).unref?.();
  }
}

httpServer.listen(config.port, () => {
  console.log(`✔ ZeroSignal API + Socket.IO listening on :${config.port} (${config.nodeEnv}); Groq ${groq.enabled ? 'enabled' : 'disabled → fallback mode'}`);
  connectMongo();
});

const shutdown = (signal) => {
  console.log(`\n${signal} received — shutting down`);
  realtime.shutdown();
  media.providers.hls?.stopAll?.();
  io.close();
  httpServer.close(() => mongoose.disconnect().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
