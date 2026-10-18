import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Check, HandHelping, Volume2, X } from 'lucide-react';
import { LANGUAGES } from '@zerosignal/shared';
import { alertText } from '../lib/receiverClient.js';
import { alertTone, hasVoice, speak, stopSpeaking } from '../lib/audio.js';
import { usePrefs } from '../lib/prefs.js';
import { CATEGORY_LABEL, CHANNEL_LABEL } from '../lib/ui.js';
import { Pill, SimBadge, VerifyBadge } from './Badges.jsx';

/**
 * Full-screen takeover for CRITICAL / HIGH alerts. It carries only verified content, the
 * recommended action in large type, and the two things a person in danger can actually do:
 * say they are safe or ask for help.
 */
export default function AlertTakeover({ alert, language, response, onRespond, onDismiss }) {
  const prefs = usePrefs();
  const closeRef = useRef(null);
  const text = alert ? alertText(alert, language) : null;
  const critical = alert?.priority === 'CRITICAL';

  useEffect(() => {
    if (!alert) return undefined;
    alertTone(alert.priority);
    closeRef.current?.focus();
    if (prefs.speak) speak(`${text.headline}. ${text.action}`, text.language);
    return () => stopSpeaking();
    // announce once per alert id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.id]);

  return (
    <AnimatePresence>
      {alert && (
        <motion.div
          key={alert.id}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="takeover-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-theme="dark" className={`text-ink fixed inset-0 z-50 flex flex-col overflow-y-auto p-4 sm:p-8 ${critical ? 'animate-siren' : 'bg-amber-950/95'}`}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <Pill color={critical ? 'var(--color-critical-soft)' : 'var(--color-warning-soft)'}>
                <AlertTriangle size={12} aria-hidden /> {critical ? 'Critical alert' : 'High priority alert'}
              </Pill>
              <Pill color="var(--color-ink)">{CATEGORY_LABEL[alert.category] ?? alert.category}</Pill>
              <VerifyBadge status={alert.verification} />
              {alert.simulated && <SimBadge label={CHANNEL_LABEL[alert.channel]} />}
            </div>

            <h1 id="takeover-title" lang={text.language} className="font-display text-3xl font-extrabold leading-tight sm:text-5xl">
              {text.headline}
            </h1>
            {text.action && (
              <p lang={text.language} className="rounded-xl border border-white/30 bg-black/40 p-4 text-xl font-semibold leading-snug sm:text-2xl">
                {text.action}
              </p>
            )}
            {text.body && text.body !== text.headline && (
              <p lang={text.language} className="max-w-prose text-base leading-relaxed text-ink/90 sm:text-lg">
                {text.body}
              </p>
            )}
            {text.language !== language && <p className="text-sm text-ink/80">Not available in {LANGUAGES[language]?.name}; showing {LANGUAGES[text.language]?.name}.</p>}

            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => onRespond('SAFE')} disabled={Boolean(response)} className={`inline-flex min-h-12 items-center gap-2 rounded-xl px-5 py-3 text-lg font-bold ${response === 'SAFE' ? 'bg-success text-black' : 'bg-white text-black'} disabled:opacity-70`}>
                <Check aria-hidden /> {response === 'SAFE' ? 'Marked safe' : 'I am safe'}
              </button>
              <button type="button" onClick={() => onRespond('NEED_HELP')} disabled={Boolean(response)} className={`inline-flex min-h-12 items-center gap-2 rounded-xl px-5 py-3 text-lg font-bold ${response === 'NEED_HELP' ? 'bg-critical-fill text-white' : 'bg-black/60 text-white ring-2 ring-white'} disabled:opacity-70`}>
                <HandHelping aria-hidden /> {response === 'NEED_HELP' ? 'Help requested' : 'I need help'}
              </button>
              {hasVoice(text.language) ? (
                <button type="button" onClick={() => speak(`${text.headline}. ${text.action}`, text.language)} className="inline-flex min-h-12 items-center gap-2 rounded-xl px-4 py-3 ring-1 ring-white/50">
                  <Volume2 aria-hidden /> Read aloud
                </button>
              ) : (
                <span className="self-center text-xs text-ink/70">No {LANGUAGES[text.language]?.name} voice on this device.</span>
              )}
            </div>
          </div>
          <div className="mx-auto mt-6 w-full max-w-3xl">
            <button ref={closeRef} type="button" onClick={onDismiss} className="inline-flex items-center gap-2 rounded-lg bg-black/50 px-4 py-2 text-sm font-medium ring-1 ring-white/30">
              <X size={16} aria-hidden /> Close (the alert stays in your list)
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
