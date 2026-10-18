import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Languages, Radio, ShieldCheck, WifiOff } from 'lucide-react';
import { computeBandwidthTier, DEFAULT_CONFIG } from '@zerosignal/shared';
import Logo from '../components/Logo.jsx';
import SignalLadder from '../components/SignalLadder.jsx';
import { useAuth, homeFor } from '../context/AuthContext.jsx';

/** An illustration of the adaptive engine: bandwidth falls, the delivery tier follows, the message never stops. */
const SWEEP = [12000, 6500, 1800, 900, 450, 160, 60, 0];

function useSweep() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const t = setInterval(() => setI((x) => (x + 1) % SWEEP.length), 1700);
    return () => clearInterval(t);
  }, []);
  return SWEEP[i];
}

const POINTS = [
  [Radio, 'Switches before it breaks', 'A trend predictor spots a falling link and drops video to audio or text early, so the alert is already small when the network gives out.'],
  [BadgeCheck, 'Signed, checked on the device', 'Every alert carries an Ed25519 signature. The receiver verifies it in the browser, and re-verifies the cached copy every time it is read.'],
  [WifiOff, 'Still shows the last verified alert offline', 'Critical alerts are cached on the device. If the link is gone, the receiver shows what it last knew, and says so.'],
  [Languages, 'English, Tamil, Hindi, Telugu', 'Alerts are translated for review, numbers are checked against the original, and read aloud where the device has a voice.'],
];

export default function Landing() {
  const { user } = useAuth();
  const kbps = useSweep();
  const tier = kbps <= 0 ? 'CACHED' : computeBandwidthTier(kbps, DEFAULT_CONFIG);
  const shown = tier;

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Logo />
        <Link to={user ? homeFor(user.role) : '/login'} className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary">
          {user ? 'Open app' : 'Sign in'}
        </Link>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-10 md:grid-cols-[1.15fr_1fr] md:pt-20">
        <div>
          <h1 className="font-display text-balance text-4xl font-extrabold leading-[1.05] sm:text-5xl lg:text-6xl">
            When networks fail, information shouldn’t.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
            ZeroSignal broadcasts emergency alerts that shrink to fit the connection each person actually has: video, audio, text under 1 KB, then the last verified alert from the device itself.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={user ? homeFor(user.role) : '/register'} className="rounded-xl bg-primary px-6 py-3 font-display font-bold text-on-primary hover:brightness-110">{user ? 'Open app' : 'Create a receiver account'}</Link>
            <a href="#how" className="rounded-xl border border-line px-6 py-3 font-medium text-muted hover:text-ink">How it adapts</a>
          </div>
        </div>

        <figure className="glass m-0 rounded-2xl p-4" aria-label="Illustration: the delivery tier follows a falling bandwidth">
          <SignalLadder tier={shown} bandwidthKbps={kbps} />
          <figcaption className="mt-3 text-xs text-muted">Illustration of the engine’s default thresholds, not a live feed. Each rung is what that bandwidth can carry.</figcaption>
        </figure>
      </section>

      <section id="how" className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:grid-cols-2">
        {POINTS.map(([Icon, title, body]) => (
          <article key={title} className="glass rounded-2xl p-5">
            <Icon className="text-primary" size={22} aria-hidden />
            <h2 className="mt-3 font-display text-lg font-bold">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
          </article>
        ))}
        <article className="glass rounded-2xl border-warning/30 p-5 sm:col-span-2">
          <ShieldCheck className="text-warning" size={22} aria-hidden />
          <h2 className="mt-3 font-display text-lg font-bold">What is simulated, and what is not</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Network conditions, the video feed, SMS fallback and mesh relay are simulated unless a real media provider is connected, and always labelled. The adaptive engine, signatures, translations, delivery retries, analytics and Live Mode measurements are real.
          </p>
        </article>
      </section>
    </div>
  );
}
