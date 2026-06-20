interface HUDProps {
  locationName: string;
  visitorName: string;
  onToggleChronicle: () => void;
  chronicleOpen: boolean;
  onToggleAbout: () => void;
  aboutOpen: boolean;
  // Narrow viewport → terser hint copy ("tap to move").
  touch: boolean;
}

// HUD — location chip + hints restyled to the design system, plus the Town
// Chronicle + About toggles (M2.1 / M2.2). The day/dusk/night canvas tint is the
// SleepOverlay's job; this is the chrome.
export function HUD({ locationName, onToggleChronicle, chronicleOpen, onToggleAbout, aboutOpen, touch }: HUDProps) {
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

      {/* Chronicle + About toggles (top-right) */}
      <div className="absolute top-3 right-3 pointer-events-auto" style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onToggleAbout}
          aria-pressed={aboutOpen}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 13px',
            borderRadius: 10,
            background: aboutOpen ? 'var(--ink)' : 'rgba(252,247,238,0.92)',
            color: aboutOpen ? '#fff' : 'var(--ink-2)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow)',
            font: '600 12px var(--display)',
            cursor: 'pointer',
          }}
        >
          About
        </button>
        <button
          onClick={onToggleChronicle}
          aria-pressed={chronicleOpen}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 13px',
            borderRadius: 10,
            background: chronicleOpen ? 'var(--ink)' : 'rgba(252,247,238,0.92)',
            color: chronicleOpen ? '#fff' : 'var(--ink-2)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow)',
            font: '600 12px var(--display)',
            cursor: 'pointer',
          }}
        >
          Chronicle
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
