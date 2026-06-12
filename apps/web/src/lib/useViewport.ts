import { useEffect, useState } from 'react';

// Viewport awareness for the panel-coexistence + minimal-touch rules (design
// doc §6.3). `narrow` flips panels (feed / docked chat) to full-screen overlays
// below the minimum town width; `touch` swaps HUD hints + enables tap affordances.
//
// SSR-safe: returns desktop defaults until mounted (static export hydrates).

export interface Viewport {
  narrow: boolean;
  touch: boolean;
}

// Below this the world canvas + a side rail no longer coexist comfortably, so
// panels become full-screen overlays instead of rails.
const NARROW_BREAKPOINT = 720;

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>({ narrow: false, touch: false });

  useEffect(() => {
    const touch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);

    const update = () => {
      setVp({ narrow: window.innerWidth < NARROW_BREAKPOINT, touch });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return vp;
}
