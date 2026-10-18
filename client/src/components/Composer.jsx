import { useMemo, useState } from 'react';
import { AlertOctagon, Bot, Loader2, Pencil, Send, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORIES, LANGUAGES, LANGUAGE_CODES, PRIORITIES, SCENARIOS, allScenarioMessages } from '@zerosignal/shared';
import { api, errorMessage } from '../lib/api.js';
import { CATEGORY_LABEL } from '../lib/ui.js';
import { Pill, PriorityBadge } from './Badges.jsx';

const ZONES = {
  none: ['No zone (everyone)', null],
  nagapattinam: ['Nagapattinam, 25 km', { lat: 10.7672, lng: 79.8449, radiusKm: 25, label: 'Nagapattinam coast' }],
  chennai: ['Chennai, 30 km', { lat: 13.0827, lng: 80.2707, radiusKm: 30, label: 'Chennai' }],
  madurai: ['Madurai, 20 km', { lat: 9.9252, lng: 78.1198, radiusKm: 20, label: 'Madurai' }],
};
const EXPIRY = [[15, '15 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '24 hours']];
const field = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-primary';

/**
 * Two-step, human-in-the-loop flow: the announcement is analysed (Groq, or the labelled rule-based
 * fallback), a person reviews and may edit every field, and only then is it signed and sent.
 */
export default function Composer({ broadcast, disabled }) {
  const presets = useMemo(() => allScenarioMessages(), []);
  const [raw, setRaw] = useState('');
  const [stage, setStage] = useState('write'); // write | review
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState(null); // { analysisId, analysis, meta }
  const [presetKey, setPresetKey] = useState(null);
  const [form, setForm] = useState({ priority: 'NORMAL', category: 'OTHER', summary: '', recommendedAction: '' });
  const [translateTo, setTranslateTo] = useState(['ta', 'hi', 'te']);
  const [expiry, setExpiry] = useState(60);
  const [zoneKey, setZoneKey] = useState('none');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => {
    setRaw('');
    setStage('write');
    setAnalysis(null);
    setPresetKey(null);
    setForm({ priority: 'NORMAL', category: 'OTHER', summary: '', recommendedAction: '' });
  };

  const usePreset = (p) => {
    const en = p.i18n.en;
    setRaw(p.raw);
    setPresetKey(p.key);
    setAnalysis(null);
    setForm({ priority: p.priority, category: p.category, summary: en.summary, recommendedAction: en.action });
    setExpiry(p.priority === 'CRITICAL' ? 360 : 60);
    setZoneKey(p.zone ? 'nagapattinam' : 'none');
    setStage('review');
  };

  const analyze = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/emergency/analyze', { text: raw });
      setAnalysis(data);
      setPresetKey(null);
      setForm({ priority: data.analysis.priority, category: data.analysis.category, summary: data.analysis.summary, recommendedAction: data.analysis.recommendedAction });
      setExpiry(data.analysis.priority === 'CRITICAL' ? 360 : data.analysis.priority === 'HIGH' ? 180 : 60);
      setStage('review');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const body = {
        broadcastId: broadcast.id,
        original: raw,
        ...form,
        expiresInMinutes: expiry,
        ...(analysis?.analysisId ? { analysisId: analysis.analysisId } : {}),
        ...(presetKey ? { presetKey } : { translateTo }),
        ...(ZONES[zoneKey][1] ? { zone: ZONES[zoneKey][1] } : {}),
      };
      const { data } = await api.post('/emergency', body);
      const d = data.dispatch;
      toast.success(`Sent to ${d.targeted} of ${d.receivers} receiver${d.receivers === 1 ? '' : 's'}${d.notTargeted ? ` (${d.notTargeted} outside the zone)` : ''}`);
      const failed = Object.entries(data.translationStatus ?? {}).filter(([, s]) => s !== 'groq' && s !== 'preset');
      if (failed.length) toast.warning(`Not translated: ${failed.map(([l]) => LANGUAGES[l]?.name ?? l).join(', ')}. Those receivers get English.`);
      if (data.supersedes?.length) toast(`Replaced ${data.supersedes.length} earlier alert${data.supersedes.length > 1 ? 's' : ''}`);
      reset();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const meta = analysis?.meta;
  const crit = form.priority === 'CRITICAL';
  const valid = form.summary.trim().length >= 3 && form.recommendedAction.trim().length >= 3 && raw.trim().length >= 10;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="mb-1.5 text-xs text-muted">Scenario presets (pre-authored, with reviewed translations)</p>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p.key} type="button" disabled={disabled} onClick={() => usePreset(p)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-primary hover:text-primary disabled:opacity-40" title={SCENARIOS[p.scenarioId].title}>
              <Wand2 size={12} aria-hidden /> {p.key.replace(/-/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Announcement</span>
        <textarea
          value={raw}
          maxLength={4000}
          rows={stage === 'write' ? 6 : 4}
          disabled={disabled || busy}
          onChange={(e) => {
            setRaw(e.target.value);
            if (presetKey) setPresetKey(null);
          }}
          placeholder="Paste or type the official announcement. It stays in your control: nothing is sent until you review it."
          className={`${field} resize-y`}
        />
        <span className="num self-end text-xs text-muted">{raw.length}/4000</span>
      </label>

      {stage === 'write' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={analyze} disabled={disabled || busy || raw.trim().length < 10} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-display text-sm font-bold text-on-primary disabled:opacity-40">
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Sparkles size={16} aria-hidden />} Analyse and review
          </button>
          <button type="button" onClick={() => setStage('review')} disabled={disabled || raw.trim().length < 10} className="inline-flex items-center gap-2 rounded-xl border border-line px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-40">
            <Pencil size={15} aria-hidden /> Fill in manually
          </button>
        </div>
      )}

      {stage === 'review' && (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
          {meta && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs" role="status">
              <Pill color={meta.fallback ? 'var(--color-warning)' : 'var(--color-accent)'}><Bot size={12} aria-hidden /> {meta.fallback ? 'Rule-based fallback' : `AI · ${meta.model}`}</Pill>
              {analysis.analysis.confidence != null && <Pill>Confidence {Math.round(analysis.analysis.confidence * 100)}%</Pill>}
              {meta.escalatedByRules && <Pill color="var(--color-critical)">Raised to CRITICAL by safety rules</Pill>}
              {meta.fallback && <span className="text-muted">{meta.reason}</span>}
            </div>
          )}
          {presetKey && <Pill color="var(--color-primary)">Preset · authored translations</Pill>}
          <p className="text-xs text-muted">Suggestion only. Check every field; what you send is what is signed.</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">Priority
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)} className={field}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            </label>
            <label className="flex flex-col gap-1 text-sm">Category
              <select value={form.category} onChange={(e) => set('category', e.target.value)} className={field}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">Headline (what shows on a text-only link)
            <input value={form.summary} maxLength={160} onChange={(e) => set('summary', e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">Recommended action
            <input value={form.recommendedAction} maxLength={160} onChange={(e) => set('recommendedAction', e.target.value)} className={field} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">Expires after
              <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} className={field}>{EXPIRY.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
            </label>
            <label className="flex flex-col gap-1 text-sm">Who gets it
              <select value={zoneKey} onChange={(e) => setZoneKey(e.target.value)} className={field}>{Object.entries(ZONES).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
          </div>
          {!presetKey && (
            <fieldset className="text-sm">
              <legend className="mb-1 text-muted">Translate to</legend>
              <div className="flex flex-wrap gap-3">
                {LANGUAGE_CODES.filter((l) => l !== 'en').map((l) => (
                  <label key={l} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={translateTo.includes(l)} onChange={(e) => setTranslateTo((t) => (e.target.checked ? [...t, l] : t.filter((x) => x !== l)))} className="accent-[var(--color-primary)]" />
                    {LANGUAGES[l].native}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">If a translation cannot be produced safely (numbers must survive unchanged), that language is skipped and receivers get English.</p>
            </fieldset>
          )}

          {crit && (
            <p className="flex items-start gap-2 rounded-lg border border-critical/50 bg-critical/10 p-2.5 text-sm text-critical">
              <AlertOctagon size={16} className="mt-0.5 shrink-0" aria-hidden /> Critical alerts take over every targeted receiver’s screen and are retried until acknowledged or expired.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={send} disabled={disabled || busy || !valid} className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 font-display font-bold disabled:opacity-40 ${crit ? 'bg-critical-fill text-white' : 'bg-primary text-on-primary'}`}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />} Sign and send <PriorityBadge priority={form.priority} />
            </button>
            <button type="button" onClick={reset} disabled={busy} className="rounded-xl border border-line px-4 py-2.5 text-sm text-muted hover:text-ink">Start over</button>
          </div>
          {disabled && <p className="text-xs text-warning">Start the broadcast to send alerts.</p>}
        </div>
      )}
    </div>
  );
}
