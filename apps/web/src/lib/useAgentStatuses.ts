import { useEffect, useState } from 'react';
import { EventBus, type WorldEvents } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';

// Live per-agent status, hydrated from the snapshot and updated as engagement /
// activity changes stream in (design doc §6.2 — status is server-authoritative
// now, not a static config field). Components subscribe to render the roster +
// profile rail with current state, falling back to a neutral line before the
// first snapshot lands (or while the town is sleeping).
export type AgentStatusMap = Partial<Record<ThomasId, WorldEvents['npc-status']>>;

export function useAgentStatuses(): AgentStatusMap {
  const [statuses, setStatuses] = useState<AgentStatusMap>({});

  useEffect(() => {
    const onStatus = (s: WorldEvents['npc-status']) => {
      setStatuses(prev => ({ ...prev, [s.npcId]: s }));
    };
    const onActivity = (a: WorldEvents['npc-activity']) => {
      setStatuses(prev => {
        const cur = prev[a.npcId];
        if (!cur) return prev;
        return { ...prev, [a.npcId]: { ...cur, activity: a.activity } };
      });
    };
    EventBus.on('npc-status', onStatus);
    EventBus.on('npc-activity', onActivity);
    return () => {
      EventBus.off('npc-status', onStatus);
      EventBus.off('npc-activity', onActivity);
    };
  }, []);

  return statuses;
}

// Human-readable status line for a roster/profile row, preferring the live
// activity, then the status string, then a neutral placeholder.
export function statusLine(status: WorldEvents['npc-status'] | undefined): string {
  if (!status) return 'somewhere in town';
  return status.activity || status.status || 'somewhere in town';
}
