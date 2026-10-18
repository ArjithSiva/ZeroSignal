/**
 * Live Mode: measure the REAL link between this browser and the server so the adaptive
 * engine can run on genuine conditions (spec §8.9). Results are reported with simulated:false.
 *
 *   latency / jitter  → 4 tiny round trips to /api/network/probe (median / mean deviation)
 *   packet loss       → share of probes that failed or timed out (an application-level proxy,
 *                       NOT true packet loss — labelled as such in the UI)
 *   bandwidth         → time to download a 64 KB payload; navigator.connection.downlink as a hint
 */
import axios from 'axios';
import { API_URL } from './api.js';

const probeUrl = `${API_URL}/api/network/probe`;
const payloadUrl = (kb) => `${API_URL}/api/network/payload?kb=${kb}`;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

export async function measureLive({ probes = 4, payloadKb = 64, timeoutMs = 4000 } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { bandwidthKbps: 0, latencyMs: 0, packetLoss: 100, jitterMs: 0, stability: 0, online: false };
  }

  const rtts = [];
  let failed = 0;
  for (let i = 0; i < probes; i++) {
    const t = performance.now();
    try {
      await axios.get(probeUrl, { timeout: timeoutMs, params: { n: Math.random() } });
      rtts.push(performance.now() - t);
    } catch {
      failed += 1;
    }
  }

  if (!rtts.length) return { bandwidthKbps: 0, latencyMs: 0, packetLoss: 100, jitterMs: 0, stability: 0, online: false };

  let bandwidthKbps = 0;
  try {
    const t = performance.now();
    const res = await axios.get(payloadUrl(payloadKb), { responseType: 'arraybuffer', timeout: timeoutMs, params: { n: Math.random() } });
    const ms = Math.max(1, performance.now() - t);
    bandwidthKbps = Math.round((res.data.byteLength * 8) / ms); // bits per ms == kbit/s
  } catch {
    failed += 1;
  }

  const hint = navigator.connection?.downlink; // Mbps, coarse
  if (!bandwidthKbps && hint) bandwidthKbps = Math.round(hint * 1000);

  const latencyMs = Math.round(median(rtts));
  const jitterMs = Math.round(rtts.reduce((a, r) => a + Math.abs(r - latencyMs), 0) / rtts.length);
  const total = probes + 1;
  const packetLoss = Math.round((failed / total) * 1000) / 10;
  const stability = Math.max(0, Math.min(100, Math.round(100 - jitterMs / 3 - packetLoss * 2)));
  return { bandwidthKbps, latencyMs, packetLoss, jitterMs, stability, online: true };
}
