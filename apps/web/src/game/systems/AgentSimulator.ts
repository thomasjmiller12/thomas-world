import { EventBus } from '../EventBus';
import { SimulatedAction, ThomasId } from '@/lib/types';
import { SIMULATION_TICK_MS } from '@/lib/constants';
import { SIMULATION_SCRIPTS } from '../data/simulation-scripts';

export class AgentSimulator {
  private agentTimers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private scriptIndices: Record<ThomasId, number> = {
    career: 0,
    researcher: 0,
    builder: 0,
    writer: 0,
    hobby: 0,
  };

  start() {
    this.stopped = false;
    const agents: ThomasId[] = ['career', 'researcher', 'builder', 'writer', 'hobby'];
    // Stagger each NPC with a random initial delay so they don't all speak at once
    for (const agentId of agents) {
      const initialDelay = 3000 + Math.random() * 12000; // 3-15s before first thought
      this.scheduleNext(agentId, initialDelay);
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.agentTimers) clearTimeout(timer);
    this.agentTimers = [];
  }

  private scheduleNext(agentId: ThomasId, delay: number) {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      if (this.stopped) return;
      const script = SIMULATION_SCRIPTS[agentId];
      if (script && script.length > 0) {
        const action = script[this.scriptIndices[agentId] % script.length];
        this.executeAction(agentId, action);
        this.scriptIndices[agentId]++;
      }
      // Schedule next action with randomized interval (15-30s between actions)
      const nextDelay = 15000 + Math.random() * 15000;
      this.scheduleNext(agentId, nextDelay);
    }, delay);
    this.agentTimers.push(timer);
  }

  private executeAction(agentId: ThomasId, action: SimulatedAction) {
    switch (action.type) {
      case 'think':
        EventBus.emit('npc-thought', {
          npcId: agentId,
          thought: action.thought || '',
        });
        break;

      case 'say':
        EventBus.emit('npc-speech', {
          npcId: agentId,
          message: action.message || '',
          audience: action.audience || 'public',
        });
        break;

      case 'move':
        if (action.target) {
          EventBus.emit('npc-move-to', {
            npcId: agentId,
            target: action.target,
          });
        }
        break;

      case 'work':
        EventBus.emit('npc-thought', {
          npcId: agentId,
          thought: action.description || 'Working...',
        });
        break;

      case 'interact_agent':
        EventBus.emit('npc-speech', {
          npcId: agentId,
          message: action.message || '',
          audience: action.targetAgent || 'public',
        });
        break;

      case 'idle':
        // Do nothing
        break;
    }
  }
}
