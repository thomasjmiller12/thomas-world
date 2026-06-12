import { EventBus } from '../EventBus';
import type { ThomasId } from '@/lib/types';

// The town-is-sleeping fallback (design doc §7, decision 11): when the world
// server is unreachable or budget-exhausted, the town must read *asleep,
// dreaming* — not broken. DreamMode is the one part of the V1 simulator worth
// keeping: a slimmed, free, fully-scripted ambient layer driven WITHOUT any
// LLM/server data. It emits the same typed EventBus events the live WorldClient
// does (npc-thought, npc-activity), so the canvas and roster keep breathing.
//
// Deliberately quiet vs. V1: dreamy half-thoughts and gentle activity, no
// agent↔agent dialogue, no movement orchestration. The full sleeping UX (night
// tint, Z's) lands in F2; this just keeps the sprites alive underneath it.

const DREAMERS: ThomasId[] = ['career', 'researcher', 'builder', 'writer', 'hobby'];

// Soft, ambient half-thoughts — no continuity claims, nothing that implies the
// agents are actually thinking right now (they're asleep).
const DREAM_THOUGHTS: Record<ThomasId, string[]> = {
  career: ['…a roadmap drifting just out of reach…', '…someone said "ship it" in a dream…'],
  researcher: ['…the posterior keeps shifting…', '…a proof that dissolves when you look at it…'],
  builder: ['…half-built things humming in the dark…', '…one more commit, then sleep…'],
  writer: ['…a sentence that almost lands…', '…the right word, just past the edge of waking…'],
  hobby: ['…a board game with no rules and all the fun…', '…the trail goes on a little longer in here…'],
};

const DREAM_ACTIVITIES: Record<ThomasId, string> = {
  career: 'dreaming',
  researcher: 'dreaming',
  builder: 'dreaming',
  writer: 'dreaming',
  hobby: 'dreaming',
};

export class DreamMode {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = true;
  private idx: Record<ThomasId, number> = {
    career: 0, researcher: 0, builder: 0, writer: 0, hobby: 0,
  };

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const id of DREAMERS) {
      EventBus.emit('npc-activity', { npcId: id, activity: DREAM_ACTIVITIES[id] });
      // Stagger so the dreams don't surface in lockstep.
      this.schedule(id, 4000 + Math.random() * 16000);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  private schedule(id: ThomasId, delay: number) {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      if (this.stopped) return;
      const pool = DREAM_THOUGHTS[id];
      const thought = pool[this.idx[id] % pool.length];
      this.idx[id]++;
      EventBus.emit('npc-thought', { npcId: id, thought });
      // Sparse: 20–45s between dream wisps so the town reads calm, not chatty.
      this.schedule(id, 20000 + Math.random() * 25000);
    }, delay);
    this.timers.push(timer);
  }
}
