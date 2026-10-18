/** Theme-aware colours: CSS variables defined in index.css (one value per theme). */
const COLORS = { success: 'var(--color-success)', warning: 'var(--color-warning)', critical: 'var(--color-critical)', primary: 'var(--color-primary)', muted: 'var(--color-muted)' };

/** Presentation metadata for tiers, modes and priorities (colour + plain-language label). */
export const TIER_META = {
  '720p': { label: '720p video', short: '720p', color: COLORS.success, blurb: 'Full video, audio and text' },
  '480p': { label: '480p video', short: '480p', color: 'var(--color-tier-480)', blurb: 'Reduced video' },
  '240p': { label: '240p video', short: '240p', color: 'var(--color-tier-240)', blurb: 'Thumbnail video' },
  AUDIO: { label: 'Audio only', short: 'Audio', color: COLORS.warning, blurb: 'Voice and text, no video' },
  TEXT: { label: 'Text only', short: 'Text', color: 'var(--color-tier-text)', blurb: 'Compact signed text (<1 KB)' },
  CACHED: { label: 'Offline · cached', short: 'Cached', color: COLORS.critical, blurb: 'Showing the last verified alert' },
};

export const MODE_LABEL = {
  RICH_MEDIA: 'Rich media',
  LOW_BANDWIDTH: 'Low bandwidth',
  AUDIO_PRIORITY: 'Audio priority',
  CRITICAL_TEXT: 'Critical text',
  OFFLINE_CACHE: 'Offline cache',
};

export const PRIORITY_META = {
  CRITICAL: { color: COLORS.critical, label: 'Critical' },
  HIGH: { color: COLORS.warning, label: 'High' },
  NORMAL: { color: COLORS.primary, label: 'Normal' },
  LOW: { color: COLORS.muted, label: 'Low' },
};

export const CATEGORY_LABEL = { CYCLONE: 'Cyclone', FLOOD: 'Flood', FIRE: 'Fire', EARTHQUAKE: 'Earthquake', MEDICAL: 'Medical', OTHER: 'Other' };

export const scoreColor = (s) => (s == null ? COLORS.muted : s >= 75 ? COLORS.success : s >= 50 ? 'var(--color-tier-240)' : s >= 30 ? COLORS.warning : COLORS.critical);

export const CHANNEL_LABEL = {
  'TEXT+MEDIA': 'Direct',
  TEXT: 'Direct · compact text',
  SMS_SIMULATED: 'Simulated SMS',
  MESH_SIMULATED: 'Simulated mesh relay',
};

export const timeAgo = (ts, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
