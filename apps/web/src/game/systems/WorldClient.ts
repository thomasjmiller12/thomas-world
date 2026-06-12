import {
  WorldEvent,
  SnapshotResponse,
  CreateVisitorResponse,
  GetVisitorResponse,
  CreateChatResponse,
  GetChatResponse,
  ChatStreamFrame,
  type AgentId,
  type LocationId,
} from '@town/contract';
import { EventBus } from '../EventBus';
import type { ThomasId, ChatMessage } from '@/lib/types';
import { NPC_CONFIGS } from '../data/npc-configs';
import {
  mapWorldEvent,
  mapAgentStatus,
  resolveWorldBaseUrl,
  reconnectDelayMs,
} from '@/lib/world/mapping';
import { SseParser, isHeartbeat } from '@/lib/world/sse';

const STORAGE_KEYS = {
  id: 'town.visitorId',
  token: 'town.visitorToken',
  name: 'town.visitorName',
} as const;

const PING_INTERVAL_MS = 60_000;

// Per-open chat session bookkeeping (one visitor↔agent(s) session at a time).
interface ActiveChat {
  sessionId: string;
  sessionToken: string;
  participants: AgentId[];
  // primary agent — the one the visitor walked up to (drives the panel header).
  primaryAgent: ThomasId;
  pingTimer: ReturnType<typeof setInterval> | null;
  abort: AbortController | null;
  // Accumulates streamed text per speaker so we can emit a whole ChatMessage on
  // turn completion (the React panel appends ChatMessage objects).
  turnText: Map<string, string>;
}

// The single client that replaces AgentSimulator + InteractionSystem +
// simulation-scripts (design doc §6.1). It owns visitor identity, snapshot
// hydration, the SSE firehose, location reporting, and the chat lifecycle, and
// translates everything into the typed EventBus events the UI consumes. All
// wire shapes are parsed through @town/contract zod schemas — drift throws here
// instead of silently corrupting the UI.
//
// Network is best-effort: any failure degrades to dream mode (a `world-sleeping`
// flag the UI reads); the town keeps running. The server is built in a parallel
// track, so this is coded against the CONTRACT, not a live server.
export class WorldClient {
  private readonly baseUrl: string;
  private visitorId: string | null = null;
  private visitorToken: string | null = null;
  private visitorName: string;

  private eventSource: EventSource | null = null;
  private lastEventId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private currentLocation: LocationId | null = null;
  private activeChat: ActiveChat | null = null;
  private stopped = false;

  constructor(visitorName: string, envUrl?: string) {
    this.visitorName = visitorName || 'Visitor';
    this.baseUrl = resolveWorldBaseUrl(
      envUrl ?? process.env.NEXT_PUBLIC_WORLD_URL
    );
  }

  // --- lifecycle ------------------------------------------------------------

  // Boot: validate/establish identity, hydrate the snapshot, open the stream.
  // Wires the overlay→client chat requests. Degrades to dream mode on failure.
  async start(): Promise<void> {
    this.stopped = false;
    this.wireOverlayBridge();
    this.wirePageHide();

    try {
      await this.establishIdentity();
    } catch {
      // Identity is needed for chat/location, but the town can still dream.
      this.goToSleep('server-down');
    }

    try {
      await this.hydrateSnapshot();
      this.openStream();
    } catch {
      this.goToSleep('server-down');
    }
  }

  stop(): void {
    this.stopped = true;
    this.closeStream();
    this.closeActiveChat();
    this.unwireOverlayBridge();
    this.unwirePageHide();
  }

  // --- identity (localStorage + boot validation + rename) -------------------

  private readStored(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStored(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* private mode / quota — identity just won't persist */
    }
  }

  private async establishIdentity(): Promise<void> {
    const storedId = this.readStored(STORAGE_KEYS.id);
    const storedToken = this.readStored(STORAGE_KEYS.token);
    const storedName = this.readStored(STORAGE_KEYS.name);

    if (storedId) {
      const res = await fetch(`${this.baseUrl}/visitors/${encodeURIComponent(storedId)}`);
      if (res.ok) {
        const visitor = GetVisitorResponse.parse(await res.json());
        this.visitorId = visitor.visitorId;
        this.visitorToken = storedToken;
        this.currentLocation = visitor.locationId ?? null;
        // Gate name differs from the stored one → PATCH the rename.
        if (this.visitorName && this.visitorName !== (storedName ?? visitor.name)) {
          await this.patchVisitor({ name: this.visitorName });
        } else {
          this.visitorName = visitor.name;
        }
        return;
      }
      if (res.status !== 404) {
        throw new Error(`visitor validation failed: ${res.status}`);
      }
      // 404 → fall through and re-register.
    }

    await this.register();
  }

  private async register(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/visitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.visitorName }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const created = CreateVisitorResponse.parse(await res.json());
    this.visitorId = created.visitorId;
    this.visitorToken = created.visitorToken;
    this.visitorName = created.name;
    this.writeStored(STORAGE_KEYS.id, created.visitorId);
    this.writeStored(STORAGE_KEYS.token, created.visitorToken);
    this.writeStored(STORAGE_KEYS.name, created.name);
  }

  private async patchVisitor(body: { locationId?: LocationId; name?: string }): Promise<void> {
    if (!this.visitorId) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.visitorToken) headers['x-visitor-token'] = this.visitorToken;
    const res = await fetch(`${this.baseUrl}/visitors/${encodeURIComponent(this.visitorId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok && body.name) {
      this.writeStored(STORAGE_KEYS.name, body.name);
      this.visitorName = body.name;
    }
  }

  // --- snapshot hydration ---------------------------------------------------

  private async hydrateSnapshot(): Promise<void> {
    const url = new URL(`${this.baseUrl}/world/snapshot`);
    if (this.visitorId) url.searchParams.set('visitorId', this.visitorId);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
    const snapshot = SnapshotResponse.parse(await res.json());

    // Initial per-agent state (positions/status/engagement).
    for (const agent of snapshot.agents) {
      const { name, payload } = mapAgentStatus(agent);
      EventBus.emit(name, payload);
    }

    // World-level state drives the tint + sleeping flag.
    EventBus.emit('world-state', snapshot.world);
    if (!snapshot.world.awake) {
      this.goToSleep('budget');
    } else {
      EventBus.emit('world-sleeping', { sleeping: false, reason: null });
    }

    // Replay recent events so late joiners see the scene already in motion.
    for (const ev of snapshot.recentEvents) {
      this.dispatchWorldEvent(ev);
    }
  }

  // --- SSE firehose (GET /events/stream, EventSource) -----------------------

  private openStream(): void {
    if (this.stopped || typeof window === 'undefined' || !('EventSource' in window)) return;
    const url = new URL(`${this.baseUrl}/events/stream`);
    if (this.visitorId) url.searchParams.set('visitorId', this.visitorId);
    // Server replays from Last-Event-ID; EventSource sends it as a header on
    // reconnect automatically, but on a fresh open after a drop we hint via
    // query so the first connection also resumes.
    if (this.lastEventId) url.searchParams.set('lastEventId', this.lastEventId);

    const es = new EventSource(url.toString());
    this.eventSource = es;

    es.onopen = () => {
      this.reconnectAttempt = 0;
    };

    es.onmessage = (msg) => this.handleStreamMessage(msg);

    es.onerror = () => {
      // EventSource auto-reconnects, but a closed connection (server down) needs
      // our own backoff + sleeping fallback so we don't hammer a dead server.
      if (es.readyState === EventSource.CLOSED) {
        this.scheduleReconnect();
      }
    };
  }

  private handleStreamMessage(msg: MessageEvent): void {
    if (msg.lastEventId) this.lastEventId = msg.lastEventId;
    // Heartbeat frames carry no JSON body — skip them.
    if (!msg.data || msg.data.trim() === '' || msg.data.startsWith(':')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      return; // ignore non-JSON keepalives
    }
    const result = WorldEvent.safeParse(parsed);
    if (!result.success) return; // unknown/forward-compat event — drop quietly
    this.dispatchWorldEvent(result.data);
  }

  private dispatchWorldEvent(ev: WorldEvent): void {
    // A live tick means the town is awake — clear any sleeping flag.
    EventBus.emit('world-sleeping', { sleeping: false, reason: null });
    for (const { name, payload } of mapWorldEvent(ev)) {
      EventBus.emit(name, payload);
    }
  }

  private scheduleReconnect(): void {
    this.closeStream();
    if (this.stopped) return;
    this.goToSleep('server-down');
    const delay = reconnectDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => this.openStream(), delay);
  }

  private closeStream(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private goToSleep(reason: 'budget' | 'server-down'): void {
    EventBus.emit('world-sleeping', { sleeping: true, reason });
  }

  // --- location reporting (PATCH on scene change) ---------------------------

  // Called by App on `scene-changed`. Reports the visitor's logical location so
  // co-located agents perceive the arrival (design doc §2).
  reportLocation(locationId: LocationId): void {
    if (locationId === this.currentLocation) return;
    this.currentLocation = locationId;
    void this.patchVisitor({ locationId }).catch(() => {
      /* best-effort; a missed location report isn't fatal */
    });
  }

  // --- fixture interaction (POST /visitors/:id/interact) --------------------

  interact(locationId: LocationId, fixture: string): void {
    if (!this.visitorId) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.visitorToken) headers['x-visitor-token'] = this.visitorToken;
    void fetch(`${this.baseUrl}/visitors/${encodeURIComponent(this.visitorId)}/interact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ locationId, fixture }),
    }).catch(() => undefined);
  }

  // --- chat lifecycle -------------------------------------------------------

  // Open a chat with an agent (Tier-1 escalate): POST /chats then stream the
  // agent-initiated greeting from /open. On a 409 (engaged) the panel gets an
  // in-fiction error to render Tier-1 alternatives.
  async openChat(agentId: ThomasId): Promise<void> {
    if (!this.visitorId) {
      EventBus.emit('chat-error', { npcId: agentId, reason: 'not-connected' });
      return;
    }
    // One body, one conversation on the visitor side too: close any prior chat.
    this.closeActiveChat();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, visitorId: this.visitorId }),
      });
    } catch {
      EventBus.emit('chat-error', { npcId: agentId, reason: 'server-down' });
      return;
    }

    if (res.status === 409) {
      EventBus.emit('chat-error', { npcId: agentId, reason: 'engaged' });
      return;
    }
    if (!res.ok) {
      EventBus.emit('chat-error', { npcId: agentId, reason: `error-${res.status}` });
      return;
    }

    const session = CreateChatResponse.parse(await res.json());
    this.activeChat = {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      participants: session.participants,
      primaryAgent: agentId,
      pingTimer: null,
      abort: null,
      turnText: new Map(),
    };
    this.startPing();

    // Stream the greeting turn.
    await this.streamTurn(`${this.baseUrl}/chats/${encodeURIComponent(session.sessionId)}/open`, {});
  }

  // Send a visitor line and stream the reply (POST /chats/:id/messages).
  async sendMessage(text: string): Promise<void> {
    const chat = this.activeChat;
    if (!chat) return;
    await this.streamTurn(
      `${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/messages`,
      { text }
    );
  }

  // Shared POST-SSE turn streamer: fetch + ReadableStream parse of
  // ChatStreamFrames (design doc §5 transport). The `type` field discriminates.
  private async streamTurn(url: string, body: Record<string, unknown>): Promise<void> {
    const chat = this.activeChat;
    if (!chat) return;
    const abort = new AbortController();
    chat.abort = abort;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': chat.sessionToken,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch {
      EventBus.emit('chat-error', { npcId: chat.primaryAgent, reason: 'stream-failed' });
      return;
    }

    if (!res.ok || !res.body) {
      EventBus.emit('chat-error', { npcId: chat.primaryAgent, reason: `error-${res.status}` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const msg of parser.feed(chunk)) {
          if (isHeartbeat(msg) || !msg.data) continue;
          this.handleChatFrame(msg.data);
        }
      }
    } catch {
      // Aborted (new turn / close) or network drop — silent; panel keeps state.
    } finally {
      chat.abort = null;
    }
  }

  private handleChatFrame(data: string): void {
    const chat = this.activeChat;
    if (!chat) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = ChatStreamFrame.safeParse(parsed);
    if (!result.success) return;
    const frame = result.data;

    switch (frame.type) {
      case 'turn_started':
        chat.turnText.set(frame.agent, '');
        EventBus.emit('chat-turn-started', { npcId: frame.agent, sessionId: chat.sessionId });
        break;

      case 'text': {
        const prev = chat.turnText.get(frame.agent) ?? '';
        chat.turnText.set(frame.agent, prev + frame.text);
        EventBus.emit('chat-delta', {
          npcId: frame.agent,
          sessionId: chat.sessionId,
          text: frame.text,
        });
        break;
      }

      case 'memory_recalled':
        EventBus.emit('chat-memory-recalled', {
          npcId: frame.agent,
          sessionId: chat.sessionId,
          label: frame.label,
        });
        break;

      case 'suggested_replies':
        EventBus.emit('chat-suggested-replies', {
          sessionId: chat.sessionId,
          replies: frame.replies,
        });
        break;

      case 'done': {
        // `agent` may be absent on single-agent turns; fall back to primary.
        const agent: ThomasId = frame.agent ?? chat.primaryAgent;
        const text = chat.turnText.get(agent) ?? '';
        chat.turnText.delete(agent);
        EventBus.emit('chat-turn-done', {
          npcId: agent,
          sessionId: chat.sessionId,
          messageId: frame.messageId,
        });
        // Whole-message convenience event for the React panel.
        const display = NPC_CONFIGS[agent]?.displayName ?? agent;
        const message: ChatMessage = {
          sender: agent,
          senderName: display,
          text,
          timestamp: Date.now(),
        };
        EventBus.emit('npc-chat-response', message);
        break;
      }

      default: {
        const _never: never = frame;
        void _never;
      }
    }
  }

  // GET /chats/:id — rehydrate the panel after a dropped stream (token-gated).
  async rehydrateChat(sessionId: string, sessionToken: string): Promise<GetChatResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/chats/${encodeURIComponent(sessionId)}`, {
        headers: { 'x-session-token': sessionToken },
      });
      if (!res.ok) return null;
      return GetChatResponse.parse(await res.json());
    } catch {
      return null;
    }
  }

  // POST /conversations/:id/join — interject into a live scene (Tier-1.5).
  async joinConversation(conversationId: string): Promise<void> {
    if (!this.visitorId) return;
    try {
      const res = await fetch(
        `${this.baseUrl}/conversations/${encodeURIComponent(conversationId)}/join`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visitorId: this.visitorId }),
        }
      );
      if (res.status === 409) {
        EventBus.emit('chat-error', { reason: 'join-lost-race' });
        return;
      }
      if (!res.ok) return;
      this.closeActiveChat();
      const session = CreateChatResponse.parse(await res.json());
      this.activeChat = {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        participants: session.participants,
        primaryAgent: session.participants[0] ?? session.agentId,
        pingTimer: null,
        abort: null,
        turnText: new Map(),
      };
      this.startPing();
    } catch {
      /* degrade to listen-in */
    }
  }

  // Visitor closed the panel — POST /close + tear down ping/stream.
  closeChat(): void {
    this.closeActiveChat();
  }

  private startPing(): void {
    const chat = this.activeChat;
    if (!chat) return;
    chat.pingTimer = setInterval(() => {
      void fetch(`${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/ping`, {
        method: 'POST',
        headers: { 'x-session-token': chat.sessionToken },
      }).catch(() => undefined);
    }, PING_INTERVAL_MS);
  }

  private closeActiveChat(): void {
    const chat = this.activeChat;
    if (!chat) return;
    this.activeChat = null;
    if (chat.pingTimer) clearInterval(chat.pingTimer);
    if (chat.abort) chat.abort.abort();
    void fetch(`${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/close`, {
      method: 'POST',
      headers: { 'x-session-token': chat.sessionToken },
    }).catch(() => undefined);
  }

  // --- overlay bridge (EventBus → client methods) ---------------------------

  private onChatOpenRequest = (p: { npcId: ThomasId }) => {
    void this.openChat(p.npcId);
  };
  private onChatMessageSent = (p: { npcId: ThomasId; message: string }) => {
    void this.sendMessage(p.message);
  };
  private onChatClosed = () => {
    this.closeChat();
  };

  private wireOverlayBridge(): void {
    EventBus.on('chat-open-request', this.onChatOpenRequest);
    EventBus.on('chat-message-sent', this.onChatMessageSent);
    EventBus.on('chat-closed', this.onChatClosed);
  }

  private unwireOverlayBridge(): void {
    EventBus.off('chat-open-request', this.onChatOpenRequest);
    EventBus.off('chat-message-sent', this.onChatMessageSent);
    EventBus.off('chat-closed', this.onChatClosed);
  }

  // --- pagehide: best-effort close via sendBeacon ---------------------------

  private onPageHide = () => {
    const chat = this.activeChat;
    if (!chat || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    // sendBeacon can't set headers; the close route accepts the token in the
    // body as a fallback for the beacon path.
    const blob = new Blob([JSON.stringify({ sessionToken: chat.sessionToken })], {
      type: 'application/json',
    });
    navigator.sendBeacon(
      `${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/close`,
      blob
    );
  };

  private wirePageHide(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', this.onPageHide);
  }

  private unwirePageHide(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pagehide', this.onPageHide);
  }
}
