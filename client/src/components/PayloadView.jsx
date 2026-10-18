import { COMPACT_MAX_BYTES, byteLength, canonicalize, dataSaved } from '@zerosignal/shared';
import { alertText } from '../lib/receiverClient.js';
import { formatKbps } from './SignalLadder.jsx';
import { Empty, SimBadge } from './Badges.jsx';

const kb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

/** What a text-only link actually carries: the signed compact payload, its size, and how long it takes to arrive. */
export default function PayloadView({ alert, language, kbps, tierSeconds }) {
  const segments = Object.entries(tierSeconds ?? {}).map(([tier, seconds]) => ({ tier, seconds }));
  const saved = dataSaved(segments, alert ? byteLength(canonicalize(alert.signed?.[language]?.payload ?? alert.signed?.en?.payload ?? {})) : 0);

  return (
    <div className="flex flex-col gap-4">
      {!alert ? (
        <Empty title="No alert yet">When an alert arrives, its signed compact payload is shown here with its size.</Empty>
      ) : (() => {
        const t = alertText(alert, language);
        const entry = alert.signed?.[t.language] ?? alert.signed?.en;
        const payload = entry?.payload;
        const json = canonicalize(payload ?? {});
        const bytes = byteLength(json);
        const full = byteLength(JSON.stringify({ translations: alert.translations ?? {}, signed: alert.signed }));
        const seconds = kbps > 0 ? (bytes * 8) / (kbps * 1000) : null;
        return (
          <>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted"><span>Compact payload</span><span className="num">{bytes} B of {COMPACT_MAX_BYTES} B limit</span></div>
              <div className="h-2 overflow-hidden rounded bg-line" role="img" aria-label={`${bytes} bytes of ${COMPACT_MAX_BYTES}`}><div className="h-full bg-primary" style={{ width: `${Math.min(100, (bytes / COMPACT_MAX_BYTES) * 100)}%` }} /></div>
              <p className="mt-2 text-sm text-muted">
                {seconds != null ? <>At {formatKbps(kbps)} this takes about <strong className="num text-ink">{seconds < 1 ? `${Math.max(1, Math.round(seconds * 1000))} ms` : `${seconds.toFixed(1)} s`}</strong>.</> : 'No usable link right now.'}
                {!alert.compact && <> The full message with all translations was {kb(full)}.</>}
              </p>
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-canvas p-3 text-xs leading-relaxed" tabIndex={0} aria-label="Signed payload JSON">{JSON.stringify(payload, null, 2)}</pre>
            <p className="break-all text-xs text-muted">Ed25519 signature: <code className="text-ink">{entry?.signature?.slice(0, 44)}…</code></p>
          </>
        );
      })()}

      <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">Data saved by adapting</p><SimBadge label="Nominal rates" /></div>
        <p className="num mt-1 font-display text-2xl font-bold">{kb(saved.savedBytes)}</p>
        <p className="text-xs text-muted">versus always sending 720p for the same {Math.round(segments.reduce((a, s) => a + s.seconds, 0))} s. Uses nominal encoding rates, not measured traffic.</p>
      </div>
    </div>
  );
}
