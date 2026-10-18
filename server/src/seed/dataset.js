/**
 * Pure seed-dataset builder (no database access).
 *
 * Network metrics, tiers and quality events are NOT hand-typed: the scenario curves are run
 * through the real adaptive engine and trend predictor (exactly as the real-time layer does),
 * so seeded history is faithful engine output. Everything is deterministic for a given `now`.
 */
import crypto from 'node:crypto';
import {
  DEMO_RECEIVERS,
  SCENARIOS,
  TIER_RANK,
  applyNoise,
  applyPreemptive,
  broadcastQualityScore,
  buildQualityEvent,
  createEngineState,
  createRng,
  decide,
  predictDegradation,
  sampleCurve,
  signalHealthScore,
} from '@zerosignal/shared';

/**
 * Internal provenance marker stored on every seeded document (select:false in the schemas, so it is
 * never returned by the API). `npm run seed:clean` removes exactly the documents that carry it.
 */
export const SEED_BATCH_ID = 'ds1';

/**
 * People in the seeded history. The email domain and shared password are NOT defined here: they come
 * from SEED_EMAIL_DOMAIN / SEED_USER_PASSWORD (see seed/run.js), so nothing in the codebase or the
 * product hard-codes a recognisable seeded address or credential.
 */
export const SEED_PEOPLE = [
  { key: 'admin', name: 'Asha Raman', local: 'asha.raman', role: 'admin', lang: 'en' },
  { key: 'broadcaster', name: 'Karthik Rao', local: 'karthik.rao', role: 'broadcaster', lang: 'en' },
  { key: 'broadcaster2', name: 'Divya Menon', local: 'divya.menon', role: 'broadcaster', lang: 'en' },
  { key: 'rx-a', name: 'Rahul Verma', local: 'rahul.verma', role: 'receiver', lang: 'en' },
  { key: 'rx-b', name: 'Nisha Patel', local: 'nisha.patel', role: 'receiver', lang: 'hi' },
  { key: 'rx-c', name: 'Meena Iyer', local: 'meena.iyer', role: 'receiver', lang: 'ta' },
  { key: 'rx-d', name: 'Lakshmi Narayanan', local: 'lakshmi.narayanan', role: 'receiver', lang: 'ta' },
  { key: 'rx-e', name: 'Suresh Babu', local: 'suresh.babu', role: 'receiver', lang: 'te' },
];
const RECEIVER_USER = { A: 'rx-a', B: 'rx-b', C: 'rx-c', D: 'rx-d' };

/** The shared scenario texts carry "(demo)" labels for the live Demo page; seeded history must not. */
const SCRUB = [[/\s*\((?:demo|sample|test)(?: zone)?\)/gi, '']];
export function scrub(value) {
  if (typeof value === 'string') return SCRUB.reduce((v, [re, to]) => v.replace(re, to), value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

/** Stable 24-hex ObjectId string derived from a key — makes seeding idempotent and referential. */
export const seedId = (key) => crypto.createHash('sha1').update(`zerosignal:${key}`).digest('hex').slice(0, 24);

const hashSeed = (s) => crypto.createHash('sha1').update(s).digest().readUInt32LE(0);
const PRIORITY_ORDER = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const EXPIRY_MIN = { CRITICAL: 360, HIGH: 720, NORMAL: 1440, LOW: 2880 };

const en = (text, summary, action) => ({ en: { text, summary, action } });
const EXTRAS = {
  relief: { priority: 'NORMAL', category: 'OTHER', raw: 'Relief camps are open at the Government Higher Secondary School and the Panchayat hall, Nagapattinam. Free food and drinking water are available. Bring identity documents if you can.', i18n: en('Relief camps are open at the Government Higher Secondary School and the Panchayat hall, Nagapattinam. Free food and drinking water are available. Bring identity documents if you can.', 'Relief camps open: Govt HSS and Panchayat hall, Nagapattinam. Food and water free.', 'Go to the nearest relief camp') },
  medical: { priority: 'NORMAL', category: 'MEDICAL', raw: 'Waterborne illness advisory: boil drinking water for 10 minutes and use ORS for diarrhoea. Medical teams are stationed at the relief camps. Visit the nearest camp if symptoms continue beyond a day.', i18n: en('Waterborne illness advisory: boil drinking water for 10 minutes and use ORS for diarrhoea. Medical teams are stationed at the relief camps. Visit the nearest camp if symptoms continue beyond a day.', 'Boil water 10 min, use ORS. Medical teams at relief camps.', 'Boil drinking water and use ORS') },
  fire: { priority: 'HIGH', category: 'FIRE', raw: 'Gas leak and fire reported near the Gandhipuram market. Keep a distance of 500 metres, avoid the area and let fire services pass. Emergency help: 112.', i18n: en('Gas leak and fire reported near the Gandhipuram market. Keep a distance of 500 metres, avoid the area and let fire services pass. Emergency help: 112.', 'FIRE: Gas leak near Gandhipuram market. Keep 500 m away. 112.', 'Avoid the area and keep 500 metres away') },
  maint: { priority: 'LOW', category: 'OTHER', raw: 'Reminder: scheduled maintenance of the Ward 7 mobile tower on Sunday between 1 AM and 3 AM.', i18n: en('Reminder: scheduled maintenance of the Ward 7 mobile tower on Sunday between 1 AM and 3 AM.', 'Ward 7 tower maintenance Sunday 1–3 AM.', 'No action needed') },
  drill: { priority: 'LOW', category: 'OTHER', raw: 'Reminder: monsoon preparedness drill on Saturday at 10 AM. This is a drill; no action is needed.', i18n: en('Reminder: monsoon preparedness drill on Saturday at 10 AM. This is a drill; no action is needed.', 'Drill Saturday 10 AM. No action needed.', 'No action needed') },
  checklist: { priority: 'NORMAL', category: 'OTHER', raw: 'Preparedness checklist: keep a torch, power bank, drinking water and your documents in a waterproof bag.', i18n: en('Preparedness checklist: keep a torch, power bank, drinking water and your documents in a waterproof bag.', 'Keep torch, power bank, water, documents ready.', 'Prepare an emergency bag') },
};

const PLAN = [
  { key: 'cyclone', scenarioId: 'cyclone', title: 'Cyclone Varuna — Coastal Tamil Nadu', description: 'Cyclone landfall response with coastal networks failing in sequence.', agoMin: 26 * 60, extras: [['relief', 100]] },
  { key: 'flood', scenarioId: 'flood', title: 'Adyar river flood advisory', description: 'Urban flood advisory for low-lying areas.', agoMin: 3 * 24 * 60, extras: [['medical', 80]] },
  { key: 'quake', scenarioId: 'earthquake', title: 'Coimbatore earthquake response', description: 'Magnitude 5.1 earthquake with a sudden congestion spike.', agoMin: 6 * 24 * 60, extras: [['fire', 50]] },
  { key: 'tower', scenarioId: 'tower', title: 'Ward 7 mobile tower outage', description: 'Local mobile tower outage.', agoMin: 9 * 24 * 60, extras: [['maint', 70]] },
  { key: 'drill', scenarioId: 'flood', title: 'Monsoon preparedness drill', description: 'Routine drill with low-priority reminders.', agoMin: 14 * 24 * 60, extras: [['drill', 10], ['checklist', 40]], skipScenarioMessages: true },
];

/** Run one receiver's curve through the engine + predictor, like the real-time layer does. */
function simulateReceiver({ curve, durationSec, rng, priorityAt, stepSec = 5 }) {
  let state = createEngineState();
  const samples = [];
  const metrics = [];
  const events = [];
  const tiers = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    const m = applyNoise(sampleCurve(curve, t), rng, 1);
    samples.push({ ts: t * 1000, ...m });
    if (samples.length > 30) samples.shift();
    const prio = priorityAt(t);
    let { decision, state: next } = decide(m, prio, state);
    state = next;
    const prediction = predictDegradation(samples, state.tier);
    if (!decision.changed && prediction.recommend) {
      const pre = applyPreemptive(state, prediction, m, prio);
      if (pre) {
        decision = pre.decision;
        state = pre.state;
      }
    }
    const health = signalHealthScore(m);
    const quality = broadcastQualityScore({ tier: state.tier, latencyMs: m.latencyMs, packetLoss: m.packetLoss, stability: m.stability });
    metrics.push({ t, m, tier: state.tier, health: health.score, quality: quality.score });
    tiers.push([t, state.tier]);
    const e = decision.changed ? buildQualityEvent(decision, {}) : null;
    if (e) events.push({ ...e, t });
  }
  return { metrics, events, tiers };
}

const tierAt = (tiers, t) => {
  let cur = tiers[0]?.[1] ?? '720p';
  for (const [tt, tier] of tiers) if (tt <= t) cur = tier;
  return cur;
};

/**
 * @param {object} p
 * @param {number} p.now epoch ms the dataset is anchored to
 * @param {string} p.passwordHash password hash applied to every seeded user
 * @param {string} p.emailDomain domain for seeded addresses (from SEED_EMAIL_DOMAIN)
 * @param {{ signMessage: Function }} p.signer
 * @param {string} [p.batchId]
 */
export function buildSeedDataset({ now, passwordHash, emailDomain, signer, batchId = SEED_BATCH_ID }) {
  if (!emailDomain) throw new Error('buildSeedDataset needs an emailDomain (SEED_EMAIL_DOMAIN)');
  const users = SEED_PEOPLE.map((u) => ({ _id: seedId(`user:${u.key}`), name: u.name, email: `${u.local}@${emailDomain}`.toLowerCase(), role: u.role, passwordHash, preferredLanguage: u.lang, active: true, seedBatchId: batchId }));
  const creatorOf = (planKey) => seedId(planKey === 'flood' || planKey === 'tower' ? 'user:broadcaster2' : 'user:broadcaster');
  const creatorId = seedId('user:broadcaster');
  const out = { users, broadcasts: [], messages: [], metrics: [], events: [], sessions: [], deliveries: [], acks: [], aiUsage: [] };

  for (const plan of PLAN) {
    const scenario = SCENARIOS[plan.scenarioId];
    const bid = seedId(`broadcast:${plan.key}`);
    const startedAt = now - plan.agoMin * 60_000;
    const endedAt = startedAt + scenario.durationSec * 1000;
    const zone = scrub(scenario.messages.find((m) => m.zone)?.zone);
    out.broadcasts.push({ _id: bid, title: plan.title, description: plan.description, status: 'ENDED', scenarioId: plan.scenarioId, createdBy: creatorOf(plan.key), startedAt: new Date(startedAt), endedAt: new Date(endedAt), zone, peakReceivers: DEMO_RECEIVERS.length, seedBatchId: batchId });

    // ── messages ──
    const defs = [
      ...(plan.skipScenarioMessages ? [] : scenario.messages.map((m) => ({ key: m.key, priority: m.priority, category: m.category, raw: m.raw, i18n: m.i18n, confidence: m.confidence, atSec: m.atSec, zone: m.zone, source: 'preset' }))),
      ...plan.extras.map(([k, atSec]) => ({ key: k, ...EXTRAS[k], confidence: 0.82, atSec, source: 'groq' })),
    ]
      .map((d) => ({ ...d, raw: scrub(d.raw), i18n: scrub(d.i18n), zone: scrub(d.zone) })) // scrub BEFORE signing so the signed payload is clean too
      .sort((a, b) => a.atSec - b.atSec);
    const msgDocs = [];
    for (const d of defs) {
      const id = seedId(`message:${plan.key}:${d.key}`);
      const sentAt = startedAt + d.atSec * 1000;
      const expiresAt = sentAt + EXPIRY_MIN[d.priority] * 60_000;
      const signed = signer.signMessage({ id, priority: d.priority, category: d.category, issuedAtSec: Math.floor(sentAt / 1000), expiresAtSec: Math.floor(expiresAt / 1000), zone: d.zone, i18n: d.i18n });
      const translations = Object.fromEntries(Object.entries(d.i18n).map(([lang, l]) => [lang, { ...l, source: lang === 'en' ? 'original' : d.source === 'preset' ? 'preset' : 'groq' }]));
      msgDocs.push({
        _id: id, broadcastId: bid, createdBy: creatorOf(plan.key), original: d.raw, summary: d.i18n.en.summary, category: d.category, priority: d.priority, recommendedAction: d.i18n.en.action, confidence: d.confidence,
        translations, zone: d.zone, aiMeta: { source: d.source === 'preset' ? 'preset' : 'groq', model: d.source === 'preset' ? 'authored-preset' : 'llama-3.3-70b-versatile', latencyMs: d.source === 'preset' ? 0 : 700 + (hashSeed(id) % 600), fallback: false, editedByHuman: false },
        signed, sentAt: new Date(sentAt), expiresAt: new Date(expiresAt), seedBatchId: batchId, _atSec: d.atSec,
      });
    }
    // Later alerts of the same category supersede earlier ones.
    for (const m of msgDocs) {
      const later = msgDocs.find((o) => o.category === m.category && o._atSec > m._atSec);
      if (later) m.supersededBy = later._id;
    }

    const priorityAt = (t) => msgDocs.filter((m) => m._atSec <= t).reduce((best, m) => (PRIORITY_ORDER.indexOf(m.priority) > PRIORITY_ORDER.indexOf(best) ? m.priority : best), 'NORMAL');

    // ── receivers: engine-driven metrics, tiers and events ──
    for (const rcv of DEMO_RECEIVERS) {
      const rng = createRng(hashSeed(`${plan.key}:${rcv.id}`));
      const sim = simulateReceiver({ curve: scenario.curves[rcv.id], durationSec: scenario.durationSec, rng, priorityAt });
      for (const s of sim.metrics) {
        out.metrics.push({ broadcastId: bid, receiverId: rcv.id, ts: new Date(startedAt + s.t * 1000), bandwidthKbps: s.m.bandwidthKbps, latencyMs: s.m.latencyMs, packetLoss: s.m.packetLoss, jitterMs: s.m.jitterMs, stability: s.m.stability, online: s.m.online, tier: s.tier, healthScore: s.health, simulated: true, seedBatchId: batchId });
      }
      for (const e of sim.events) {
        const { t, ...rest } = e;
        out.events.push({ ...rest, broadcastId: bid, receiverId: rcv.id, at: new Date(startedAt + t * 1000), seedBatchId: batchId });
      }
      out.sessions.push({ _id: seedId(`session:${plan.key}:${rcv.id}`), broadcastId: bid, receiverId: rcv.id, userId: seedId(`user:${RECEIVER_USER[rcv.id]}`), name: rcv.name, language: rcv.id === 'A' ? 'en' : rcv.id === 'B' ? 'hi' : 'ta', location: rcv.location, joinedAt: new Date(startedAt + 2000), leftAt: new Date(endedAt), lastTier: sim.tiers.at(-1)[1], reconnects: rcv.id === 'C' ? 1 + (hashSeed(plan.key) % 2) : 0, seedBatchId: batchId });

      // ── deliveries & acks ──
      for (const m of msgDocs) {
        const t = m._atSec;
        const tier = tierAt(sim.tiers, t);
        const offline = tier === 'CACHED';
        const poor = TIER_RANK[tier] <= TIER_RANK.AUDIO;
        const deferred = m.priority === 'LOW' && poor;
        const sms = offline && (m.priority === 'CRITICAL' || m.priority === 'HIGH');
        const delay = offline ? 25_000 : tier === 'TEXT' ? 900 : 300;
        const status = deferred ? 'DEFERRED' : m.priority === 'CRITICAL' && rcv.id !== 'B' ? 'ACKED' : 'DELIVERED';
        out.deliveries.push({
          messageId: m._id, broadcastId: bid, receiverId: rcv.id, priority: m.priority, channel: sms ? 'SMS_SIMULATED' : 'TEXT', status, attempts: m.priority === 'CRITICAL' ? 1 + (offline ? 3 : 0) : 1,
          deliveredAt: deferred ? undefined : new Date(startedAt + t * 1000 + delay), ackedAt: status === 'ACKED' ? new Date(startedAt + t * 1000 + delay + 4000) : undefined, seedBatchId: batchId,
        });
        if (m.priority === 'CRITICAL' && !deferred) {
          out.acks.push({ messageId: m._id, broadcastId: bid, receiverId: rcv.id, userId: seedId(`user:${RECEIVER_USER[rcv.id]}`), status: rcv.id === 'C' ? 'NEED_HELP' : 'SAFE', location: { lat: rcv.location.lat + 0.004 * (hashSeed(rcv.id) % 3), lng: rcv.location.lng + 0.004 * (hashSeed(plan.key) % 3) }, at: new Date(startedAt + t * 1000 + delay + 12_000), seedBatchId: batchId });
        }
      }
    }
    for (const m of msgDocs) {
      delete m._atSec;
      out.messages.push(m);
    }
  }

  // A scheduled broadcast the dashboard can start straight away.
  out.broadcasts.push({ _id: seedId('broadcast:live'), title: 'Cyclone Varuna — coastal watch', description: 'Ready to go live from the broadcaster dashboard.', status: 'SCHEDULED', scenarioId: 'cyclone', createdBy: creatorId, peakReceivers: 0, zone: scrub(SCENARIOS.cyclone.messages.find((m) => m.zone).zone), seedBatchId: batchId });

  // AI usage over the last 30 days: mostly healthy Groq calls, a few realistic failures.
  const rng = createRng(hashSeed('ai-usage'));
  const kinds = ['analyze', 'translate', 'translate', 'summarize'];
  for (let i = 0; i < 40; i++) {
    const kind = kinds[i % kinds.length];
    const failed = i % 13 === 7;
    out.aiUsage.push({ kind, ok: !failed, source: failed ? 'fallback' : 'groq', latencyMs: failed ? 8000 : Math.round(500 + rng() * 1500), error: failed ? (i % 2 ? 'TIMEOUT' : 'RATE_LIMIT') : undefined, userId: creatorId, at: new Date(now - Math.round(rng() * 30 * 24 * 3600 * 1000)), seedBatchId: batchId });
  }

  return out;
}

