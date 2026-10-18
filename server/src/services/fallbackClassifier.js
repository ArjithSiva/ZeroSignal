/**
 * Rule-based keyword classifier — the graceful-degradation path when Groq is unavailable,
 * times out, rate-limits, or returns invalid JSON. Deterministic and offline.
 * Its confidence is deliberately capped (≤ 0.7) so the UI never presents it as AI-grade.
 */
import { sanitizeText } from '../utils/sanitize.js';

const CATEGORY_RULES = [
  { category: 'CYCLONE', words: ['cyclone', 'storm surge', 'landfall', 'hurricane', 'typhoon', 'depression in the bay'] },
  { category: 'FLOOD', words: ['flood', 'inundat', 'river has crossed', 'danger level', 'water level', 'waterlogg', 'dam release', 'heavy rain'] },
  { category: 'EARTHQUAKE', words: ['earthquake', 'aftershock', 'tremor', 'seismic', 'magnitude'] },
  { category: 'FIRE', words: ['fire', 'blaze', 'smoke', 'burning', 'explosion', 'gas leak'] },
  { category: 'MEDICAL', words: ['medical', 'outbreak', 'epidemic', 'ambulance', 'injured', 'casualt', 'hospital', 'cholera', 'poison'] },
];

const CRITICAL_WORDS = ['evacuate', 'evacuation', 'immediately', 'life-threatening', 'life threatening', 'urgent', 'landfall', 'tsunami', 'collapse', 'trapped', 'do not enter', 'danger to life', 'take shelter', 'move to higher ground'];
const HIGH_WORDS = ['warning', 'alert', 'danger', 'avoid', 'stay indoors', 'shelter', 'relief camp', 'rescue', 'watch', 'return to harbour', 'closed', 'outage'];
const LOW_WORDS = ['reminder', 'fyi', 'for your information', 'scheduled', 'maintenance', 'drill', 'test message', 'routine'];

const ACTIONS = {
  CYCLONE: 'Move to the nearest cyclone shelter and follow local authority instructions',
  FLOOD: 'Move to higher ground and avoid flooded roads and underpasses',
  EARTHQUAKE: 'Move to an open area and stay away from damaged buildings',
  FIRE: 'Leave the area immediately and call emergency services',
  MEDICAL: 'Seek medical help and follow health-authority guidance',
  OTHER: 'Follow instructions from local authorities',
};

const countHits = (text, words) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/**
 * @param {string} rawText
 * @returns {{ priority: string, category: string, summary: string, recommendedAction: string, confidence: number }}
 */
export function fallbackClassify(rawText) {
  const text = sanitizeText(rawText, 4000);
  const lower = text.toLowerCase();

  let category = 'OTHER';
  let best = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = countHits(lower, rule.words);
    if (hits > best) {
      best = hits;
      category = rule.category;
    }
  }

  const critical = countHits(lower, CRITICAL_WORDS);
  const high = countHits(lower, HIGH_WORDS);
  const low = countHits(lower, LOW_WORDS);

  let priority = 'NORMAL';
  if (critical >= 2 || (critical >= 1 && category !== 'OTHER')) priority = 'CRITICAL';
  else if (critical >= 1 || high >= 1) priority = 'HIGH';
  else if (low >= 1 && best === 0) priority = 'LOW';
  // Safety bias: when the rules are unsure about a hazard, never under-prioritise it to LOW.
  if (priority === 'LOW' && category !== 'OTHER') priority = 'NORMAL';

  const evidence = best + critical + high + low;
  const confidence = Math.min(0.7, 0.35 + evidence * 0.07);

  return {
    priority,
    category,
    summary: makeSummary(text, category, priority),
    recommendedAction: ACTIONS[category],
    confidence: Math.round(confidence * 100) / 100,
  };
}

/** Headline-style extractive summary, ≤ 140 chars. */
export function makeSummary(text, category, priority) {
  const clean = sanitizeText(text, 4000).replace(/\s+/g, ' ');
  const sentences = clean.split(/(?<=[.!?।])\s+/).filter(Boolean);
  const first = sentences[0] ?? clean;
  const tag = priority === 'CRITICAL' ? `${category}: ` : '';
  const body = first.replace(/^urgent:?\s*/i, '');
  const out = `${tag}${body}`;
  return out.length <= 140 ? out : `${out.slice(0, 137).trimEnd()}…`;
}
