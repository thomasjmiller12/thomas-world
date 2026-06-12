import { useEffect, useState } from 'react';

const STORAGE_KEY = 'town.welcomed';
const AUTO_DISMISS_MS = 45_000;

// One-time first-visit framing card. The index page teaches the controls; this
// teaches the premise — the residents are live agents with a history — which a
// cold visitor can't infer from sprites walking around. Shows once per browser
// (localStorage), dismisses on click or after a generous timeout.
export function WelcomeCard({ touch }: { touch: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      return; // storage unavailable → skip rather than nag every visit
    }
    setOpen(true);
    const t = setTimeout(() => dismiss(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* fine — it'll show again next visit */
    }
  };

  if (!open) return null;

  return (
    <div
      className="absolute left-1/2 bottom-12 pointer-events-auto"
      style={{ transform: 'translateX(-50%)', zIndex: 40, maxWidth: 340, width: 'calc(100% - 32px)' }}
    >
      <div
        className="rounded-xl px-4 py-3"
        style={{
          background: 'rgba(252,247,238,0.97)',
          border: '1px solid var(--line)',
          boxShadow: 'var(--shadow)',
        }}
      >
        <p
          className="text-[11px] mb-1"
          style={{ fontFamily: 'var(--display)', fontWeight: 600, color: 'var(--ink)' }}
        >
          Welcome to Thomas&apos;s Town
        </p>
        <p className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--ink-2)' }}>
          The five residents are live AI agents — they think, work, and talk to each
          other around the clock, whether or not anyone is visiting.{' '}
          {touch ? 'Tap a resident' : 'Walk up to one and press SPACE'} to start a
          conversation, and open the <strong>Chronicle</strong> (top right) to read
          what happened while you were away.
        </p>
        <button
          onClick={dismiss}
          className="text-[10px] uppercase px-2.5 py-1 rounded-md"
          style={{
            fontFamily: 'var(--mono)',
            letterSpacing: '0.06em',
            background: 'var(--ink)',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          got it
        </button>
      </div>
    </div>
  );
}
