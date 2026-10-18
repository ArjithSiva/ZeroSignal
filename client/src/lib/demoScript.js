/**
 * The 3.5-minute auto-pilot story (spec §14), as data. Captions narrate; actions drive the real
 * system (the network conditions they set are simulated, everything downstream is not).
 *
 * Action types: start | kbps | curves | analyze | emergency | language | offline | online | summary | end
 */
export const RECEIVER_IDS = ['A', 'B', 'C', 'D'];

/**
 * Static conditions from spec §4.9, as full metric sets so each lands on its tier reliably
 * (A is set above 8 Mbps so noise cannot tip it under the 720p line; B sits just above 2 Mbps).
 */
export const SPEC_CONDITIONS = {
  A: { bandwidthKbps: 11000, latencyMs: 25, packetLoss: 0.2, jitterMs: 5, stability: 97 },
  B: { bandwidthKbps: 2600, latencyMs: 70, packetLoss: 0.6, jitterMs: 10, stability: 92 },
  C: { bandwidthKbps: 80, latencyMs: 450, packetLoss: 6, jitterMs: 70, stability: 45 },
  D: { bandwidthKbps: 5000, latencyMs: 50, packetLoss: 0.5, jitterMs: 8, stability: 92 },
};

export const AUTOPILOT = [
  { at: 0, caption: 'A cyclone is hours from landfall. Phones will lose signal exactly where people need the warning, and an alert that needs video fails with the network.', actions: [{ type: 'start', startAll: 'EXCELLENT' }] },
  { at: 14, caption: 'The broadcast is live. Four receivers, all on strong links: full 720p video.' },
  { at: 22, caption: 'Now the storm closes in. Each receiver’s network degrades on its own curve. Watch the delivery tier follow: 720p → 480p → 240p → audio.', actions: [{ type: 'curves', scenario: 'cyclone' }] },
  { at: 48, caption: 'The engine does not wait for a failure. When a trend predicts a drop, it switches ahead of it.' },
  { at: 62, caption: 'An official announcement arrives, long and messy. The AI classifies it for a human to review: CRITICAL, CYCLONE, evacuate.', actions: [{ type: 'analyze', preset: 'cyclone-landfall' }] },
  { at: 76, caption: 'Sent. Receiver C is down to a thin link: video is gone, but the signed alert still arrives as compact text.', actions: [{ type: 'emergency', preset: 'cyclone-landfall' }] },
  { at: 98, caption: 'Same alert, in the language each person reads. Tamil first.', actions: [{ type: 'language', lang: 'ta' }] },
  { at: 106, caption: 'Hindi.', actions: [{ type: 'language', lang: 'hi' }] },
  { at: 114, caption: 'Telugu.', actions: [{ type: 'language', lang: 'te' }] },
  { at: 122, caption: 'And back to English.', actions: [{ type: 'language', lang: 'en' }] },
  { at: 134, caption: 'Receiver C loses its connection entirely. It still shows the last verified alert from the device, clearly marked as cached.', actions: [{ type: 'offline', id: 'C' }] },
  { at: 160, caption: 'The tower comes back. The receiver reconnects and resyncs anything it missed.', actions: [{ type: 'online', id: 'C' }] },
  { at: 176, caption: 'What the system measured: how many alerts were delivered, how many times it adapted, and that every critical alert was preserved.', actions: [{ type: 'summary' }] },
  { at: 200, caption: 'When networks fail, information shouldn’t.', actions: [{ type: 'end' }] },
];

export const AUTOPILOT_SECONDS = AUTOPILOT.at(-1).at + 10;
