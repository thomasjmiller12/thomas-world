interface HUDProps {
  locationName: string;
  visitorName: string;
}

export function HUD({ locationName }: HUDProps) {
  return (
    <>
      <div className="absolute top-3 left-3">
        <div
          className="rounded-lg px-3 py-1.5"
          style={{
            background: 'rgba(252,247,238,0.9)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow)',
          }}
        >
          <p
            className="text-[10px] uppercase"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em', color: 'var(--ink-2)' }}
          >
            {locationName}
          </p>
        </div>
      </div>

      <div className="absolute bottom-3 left-3">
        <div className="rounded px-2 py-1" style={{ background: 'rgba(252,247,238,0.6)' }}>
          <p
            className="text-[8px] uppercase"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.08em', color: 'var(--ink-3)' }}
          >
            WASD to move
          </p>
        </div>
      </div>
    </>
  );
}
