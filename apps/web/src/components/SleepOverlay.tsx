import type { DayPhase } from '@town/contract';

// The town-is-sleeping / day-phase tint over the canvas (design doc §7,
// decision 11). Two roles in one overlay:
//
//   - Day-phase tint (always on): a subtle wash keyed to world.time — clear by
//     day, warm at dusk, deep blue at night — so the canvas reads the hour.
//   - Sleeping fallback (when the world is unreachable or budget-exhausted): a
//     deeper night tint + drifting Z's over the houses + a cozy line. The town
//     reads *asleep, dreaming* (the DreamMode ambient layer keeps the sprites
//     breathing underneath), never broken.
//
// Purely presentational; pointer-events-none so it never eats canvas input.

interface Props {
  phase: DayPhase;
  sleeping: boolean;
  // 'budget' → "dreaming" copy; 'server-down' → "resting" copy. Null when awake.
  reason: 'budget' | 'server-down' | null;
}

// Per-phase wash (rgba). Night/dawn carry a blue cast; dusk a warm one.
const PHASE_TINT: Record<DayPhase, string> = {
  dawn: 'rgba(70, 80, 130, 0.12)',
  morning: 'rgba(0, 0, 0, 0)',
  afternoon: 'rgba(0, 0, 0, 0)',
  evening: 'rgba(120, 70, 40, 0.16)',
  night: 'rgba(20, 24, 60, 0.34)',
};

export function SleepOverlay({ phase, sleeping, reason }: Props) {
  const tint = sleeping ? 'rgba(16, 18, 48, 0.46)' : PHASE_TINT[phase];

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20, overflow: 'hidden' }}>
      {/* tint wash */}
      <div className="absolute inset-0" style={{ background: tint, transition: 'background 1.2s ease' }} />

      {sleeping && (
        <>
          {/* drifting Z's */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${24 + i * 26}%`,
                top: `${30 + (i % 2) * 8}%`,
                font: `700 ${22 - i * 4}px var(--display)`,
                color: 'rgba(247, 241, 230, 0.7)',
                animation: `zfloat 4.5s ${i * 0.9}s ease-in-out infinite`,
                textShadow: '0 2px 8px rgba(0,0,0,0.4)',
              }}
            >
              Z
            </div>
          ))}

          {/* cozy line */}
          <div
            className="absolute left-1/2 bottom-8"
            style={{ transform: 'translateX(-50%)', textAlign: 'center', maxWidth: 360 }}
          >
            <div style={{ font: '600 15px var(--display)', color: 'rgba(247,241,230,0.92)' }}>
              {reason === 'budget' ? 'The town is dreaming' : 'The town is resting'}
            </div>
            <div style={{ fontSize: 12.5, color: 'rgba(247,241,230,0.7)', marginTop: 4, lineHeight: 1.45 }}>
              {reason === 'budget'
                ? 'The five are asleep for now — wander, and read what they got up to today.'
                : "Can't reach the town right now. Here's the last we saw of it."}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
