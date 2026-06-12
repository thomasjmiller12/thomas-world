interface HUDProps {
  locationName: string;
  visitorName: string;
  onToggleFeed: () => void;
  feedOpen: boolean;
  // Narrow viewport → terser hint copy ("tap to move").
  touch: boolean;
}

// HUD — location chip + hints restyled to the design system, plus the feed
// toggle (design doc §6.3). The day/dusk/night canvas tint is the SleepOverlay's
// job; this is the chrome.
export function HUD({ locationName, onToggleFeed, feedOpen, touch }: HUDProps) {
  return (
    <>
      {/* location chip (top-left) */}
      <div className="absolute top-3 left-3 pointer-events-none">
        <div
          className="rounded-lg px-3 py-1.5"
          style={{ background: 'rgba(252,247,238,0.92)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)' }}
        >
          <p
            className="text-[10px] uppercase"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em', color: 'var(--ink-2)' }}
          >
            {locationName}
          </p>
        </div>
      </div>

      {/* feed toggle (top-right) */}
      <div className="absolute top-3 right-3 pointer-events-auto">
        <button
          onClick={onToggleFeed}
          aria-pressed={feedOpen}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 13px',
            borderRadius: 10,
            background: feedOpen ? 'var(--ink)' : 'rgba(252,247,238,0.92)',
            color: feedOpen ? '#fff' : 'var(--ink-2)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow)',
            font: '600 12px var(--display)',
            cursor: 'pointer',
          }}
        >
          📜 Today
        </button>
      </div>

      {/* movement hint (bottom-left) */}
      <div className="absolute bottom-3 left-3 pointer-events-none">
        <div className="rounded px-2 py-1" style={{ background: 'rgba(252,247,238,0.6)' }}>
          <p
            className="text-[8px] uppercase"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.08em', color: 'var(--ink-3)' }}
          >
            {touch ? 'Tap to move · tap a resident to talk' : 'WASD to move · SPACE to talk'}
          </p>
        </div>
      </div>
    </>
  );
}
