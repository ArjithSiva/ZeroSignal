/**
 * Turn two successive WebRTC stats reports into the network metrics the adaptive engine understands.
 * Pure (no browser APIs) so it is unit-tested. These numbers are MEASURED from the real connection.
 *
 * Honest limit: the receive bitrate is capped by the layer we are on. When the browser reports
 * `availableIncomingBitrate` (the congestion controller's own estimate) we use that, because it reflects
 * link headroom; otherwise we can only report what we received, which can demote but cannot show headroom
 * to step back up. The README documents this.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Flatten an RTCStatsReport (or an array / Map of stats) into inbound-rtp totals + the selected candidate pair. */
export function summarizeReport(report) {
  const rows = report instanceof Map || typeof report?.forEach === 'function' ? [...(report.values ? report.values() : [])] : Array.isArray(report) ? report : [];
  const s = { bytes: 0, received: 0, lost: 0, jitterMs: 0, jitterN: 0, rttMs: null, availableKbps: null };
  for (const r of rows) {
    if (r.type === 'inbound-rtp' && !r.isRemote) {
      s.bytes += r.bytesReceived ?? 0;
      s.received += r.packetsReceived ?? 0;
      s.lost += Math.max(0, r.packetsLost ?? 0);
      if (typeof r.jitter === 'number') { s.jitterMs += r.jitter * 1000; s.jitterN += 1; }
    } else if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded' || r.selected)) {
      if (typeof r.currentRoundTripTime === 'number') s.rttMs = r.currentRoundTripTime * 1000;
      if (typeof r.availableIncomingBitrate === 'number') s.availableKbps = r.availableIncomingBitrate / 1000;
    }
  }
  s.jitterMs = s.jitterN ? s.jitterMs / s.jitterN : 0;
  return s;
}

/**
 * @param {ReturnType<typeof summarizeReport>} prev
 * @param {ReturnType<typeof summarizeReport>} cur
 * @param {number} dtMs time between the two samples
 * @param {number[]} [recentKbps] recent receive bitrates (for the stability figure)
 * @returns {{bandwidthKbps:number, latencyMs:number, packetLoss:number, jitterMs:number, stability:number, online:boolean, receiveKbps:number}|null}
 */
export function metricsFromStats(prev, cur, dtMs, recentKbps = []) {
  if (!prev || !cur || dtMs <= 0) return null;
  const receiveKbps = Math.max(0, ((cur.bytes - prev.bytes) * 8) / dtMs); // bits per ms == kbit/s
  const recv = Math.max(0, cur.received - prev.received);
  const lost = Math.max(0, cur.lost - prev.lost);
  const packetLoss = recv + lost > 0 ? (lost / (recv + lost)) * 100 : 0;
  const series = [...recentKbps, receiveKbps].slice(-8);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  const stability = mean > 0 ? clamp(100 - (sd / mean) * 100, 0, 100) : 0;
  const bandwidthKbps = cur.availableKbps != null && cur.availableKbps > 0 ? cur.availableKbps : receiveKbps;
  return {
    bandwidthKbps: Math.round(bandwidthKbps),
    latencyMs: Math.round(cur.rttMs ?? 0),
    packetLoss: Math.round(packetLoss * 10) / 10,
    jitterMs: Math.round(cur.jitterMs),
    stability: Math.round(stability),
    online: true,
    receiveKbps: Math.round(receiveKbps),
  };
}
