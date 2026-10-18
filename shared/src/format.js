/** Small, pure formatting + math helpers shared by the engine, scores and UI. */

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const round = (n, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/**
 * Human-readable bandwidth. Input is Kbps.
 * @param {number} kbps
 * @returns {string} e.g. "8 Mbps", "2.4 Mbps", "80 Kbps"
 */
export function formatBandwidth(kbps) {
  if (!Number.isFinite(kbps)) return 'n/a';
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1).replace(/\.0$/, '')} Mbps`;
  }
  return `${Math.round(kbps)} Kbps`;
}

/** @param {number} n percentage value already in 0–100 */
export const formatPercent = (n) => `${round(n, 1)}%`;
