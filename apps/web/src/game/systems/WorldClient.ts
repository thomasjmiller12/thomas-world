import {
  WorldEvent,
  SnapshotResponse,
  CreateVisitorResponse,
  GetVisitorResponse,
  CreateChatResponse,
  GetChatResponse,
  JoinChatResponse,
  ChatHistoryResponse,
  ChatStreamFrame,
  worldEventTypes,
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
import { PendingChatMessages } from '@/lib/world/pending-chat-messages';
import { availabilityForTransport } from '@/lib/world/availability';

// Momentary events — animations, popups, bubbles — that must NOT replay when a
// visitor joins (they'd fire stale: a phone ringing / a bit popping for an event
// from 30 minutes ago). They play normally on the LIVE stream; they're only
// skipped during the initial snapshot replay (see applySnapshot).
const TRANSIENT_ON_JOIN = new Set<WorldEvent['type']>([
  'world.effect', // fixture effect (phone ring, lamp flicker, espresso hiss)
  'world.beat', // director beat (popup card, emote)
  'agent.spoke', // speech bubble
  'agent.thought', // thought wisp
  // A stale replayed escort COMMAND would yank the visitor's sprite into an
  // unsolicited auto-walk on reconnect/late-join — never replay it.
  'visitor.escorted',
  // Object-graph + artifact-state events: PlacedObjects / ArtifactFrame do a
  // full authoritative fetch on scene create / open, so join-replay would only
  // double-apply what the fetch already delivered.
  'object.created',
  'object.removed',
  'object.moved',
  'object.attached',
  'artifact.state_changed',
]);

const STORAGE_KEYS = {
  id: 'town.visitorId',
  token: 'town.visitorToken',
  name: 'town.visitorName',
  // Last good snapshot — replayed when the server is unreachable so a returning
  // (or even first-time, once cached) visitor sees a populated dreaming town
  // rather than an empty one (design doc §7).
  snapshot: 'town.lastSnapshot',
} as const;

const PING_INTERVAL_MS = 60_000;

// Periodic authoritative re-sync. Railway's edge recycles long-lived SSE
// connections (~15 min); a silent drop + EventSource auto-reconnect can miss
// moves beyond the server's bounded backlog replay, leaving sprites frozen
// until a manual refresh re-reads the snapshot. We instead re-hydrate the
// snapshot on every reconnect, on tab-focus regain, and on this slow timer —
// the snapshot is the source of truth for positions, so this self-heals the
// "agents don't move until I refresh" staleness without waiting on the stream.
const RESYNC_INTERVAL_MS = 90_000;
const STREAM_LEASE_MS = 12_000;
const STREAM_LEASE_RENEW_MS = 4_000;

type StreamChannelMessage =
  | { kind: 'event'; sender: string; event: unknown }
  | {
      kind: 'availability';
      sender: string;
      state: 'live' | 'reconnecting' | 'budget-asleep' | 'unavailable';
    }
  | { kind: 'released'; sender: string };

// Per-open chat session bookkeeping (one visitor↔agent(s) session at a time).
interface ActiveChat {
  sessionId: string;
  sessionToken: string;
  participants: AgentId[];
  // Currently addressed facet (drives the panel header and direct reply).
  primaryAgent: ThomasId;
  pingTimer: ReturnType<typeof setInterval> | null;
  abort: AbortController | null;
  // Accumulates streamed text per speaker so we can emit a whole ChatMessage on
  // turn completion (the React panel appends ChatMessage objects).
  turnText: Map<string, string>;
  // Set when the in-flight stream has delivered its whole-response terminal
  // frame (response_done / chat_ended). A stream that ends without one was killed mid-turn (proxy
  // idle-timeout during a long tool round) → recoverDroppedTurn().
  streamSettled: boolean;
  seenMessageIds: Set<string>;
}

// The single client that replaces AgentSimulator + InteractionSystem +
// simulation-scripts (design doc §6.1). It owns visitor identity, snapshot
// hydration, the SSE firehose, location reporting, and the chat lifecycle, and
// translates everything into the typed EventBus events the UI consumes. All
// wire shapes are parsed through @town/contract zod schemas — drift throws here
// instead of silently corrupting the UI.
//
// Network is best-effort: snapshot truth and stream transport are reported
// separately through `world-availability`; the town keeps running. The server is built in a parallel
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
  // Cross-tab SSE ownership. One visible tab per browser identity owns the
  // network stream; siblings receive its public frames over BroadcastChannel.
  // This prevents the per-IP cap from turning ordinary tab churn into a 429
  // reconnect storm while preserving a fully authoritative resync on focus.
  private readonly tabId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private streamChannel: BroadcastChannel | null = null;
  private streamLeaseKey: string | null = null;
  private streamOwner = false;
  private streamLeaseTimer: ReturnType<typeof setInterval> | null = null;
  private streamClaimTimer: ReturnType<typeof setTimeout> | null = null;
  // True once the SSE stream has opened at least once. A subsequent `onopen` is
  // a reconnect — we re-hydrate the snapshot so authoritative positions are
  // corrected even if the gap exceeded the server's backlog replay window.
  private hasConnectedOnce = false;
  // Slow authoritative re-sync timer + in-flight guard (see RESYNC_INTERVAL_MS).
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private resyncing = false;
  // Only a live snapshot can establish budget availability. Stream traffic is
  // transport evidence, not proof that the hard daily budget is available.
  private authoritativeAwake: boolean | null = null;

  private currentLocation: LocationId | null = null;
  private desiredLocation: LocationId | null = null;
  private locationPatch: Promise<void> = Promise.resolve();
  private activeChat: ActiveChat | null = null;
  private stopped = false;
  // start() is idempotent: scene transitions re-emit `current-scene-ready`, but
  // boot (identity + stream wiring) must happen exactly once per client.
  // Re-running it would leak EventSource connections. Per-scene re-sync goes
  // through resyncScene(), not start().
  private started = false;
  // The last applied snapshot, kept so resyncScene() can re-emit per-agent
  // status to a freshly-created NPCManager WITHOUT re-opening streams.
  private lastSnapshot: SnapshotResponse | null = null;
  // Every optimistic visitor line is retained in FIFO order and one drain loop
  // owns session creation + POST-SSE turns. This prevents rapid sends from
  // overwriting each other or racing two session opens.
  private readonly pendingMessages = new PendingChatMessages<ThomasId>();
  private drainingMessages = false;

  // Observe mode (spectator): never registers a visitor, never reports
  // location, never interacts or chats — reads only (snapshot + SSE without a
  // visitorId). Agents cannot perceive an observer.
  private readonly observe: boolean;

  constructor(visitorName: string, opts: { envUrl?: string; observe?: boolean } = {}) {
    this.visitorName = visitorName || 'Visitor';
    this.observe = opts.observe ?? false;
    this.baseUrl = resolveWorldBaseUrl(
      opts.envUrl ?? process.env.NEXT_PUBLIC_WORLD_URL
    );
  }

  // --- lifecycle ------------------------------------------------------------

  // Boot: validate/establish identity, hydrate the snapshot, open the stream.
  // Degrades to dream mode on failure.
  async start(): Promise<void> {
    // Idempotent: re-entry (e.g. a second `current-scene-ready`) is a no-op so we
    // never open a second EventSource.
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.wirePageHide();
    this.wireVisibility();
    this.startResyncTimer();

    if (!this.observe) {
      try {
        await this.establishIdentity();
      } catch {
        // Identity is needed for chat/location, but a failed identity request
        // says nothing about whether the public town itself is awake.
        this.setAvailability('reconnecting');
      }
    }

    try {
      await this.hydrateSnapshotWithRetry();
    } catch {
      // Server unreachable: replay the last cached snapshot so the dreaming town
      // is populated (sprites + roster + a starting point for the feed), then
      // fall asleep. A first-time visitor with no cache still gets dream mode +
      // whatever the (independent) feed fetch can load.
      this.replayCachedSnapshot();
      this.setAvailability('unavailable');
    }
    this.startStreamCoordination();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.stopStreamCoordination();
    this.closeActiveChat();
    this.unwirePageHide();
    this.unwireVisibility();
    this.stopResyncTimer();
  }

  // Per-scene re-sync (App calls this on `current-scene-ready`, NOT start()). A
  // scene transition tears down the old NPCManager and builds a fresh one whose
  // sprite roster is empty until it learns agent locations. Re-emit the cached
  // snapshot's per-agent status so the new manager spawns the agents that belong
  // in the new scene — WITHOUT re-registering listeners or re-opening the stream.
  resyncScene(): void {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return;
    for (const agent of snapshot.agents) {
      const { name, payload } = mapAgentStatus(agent);
      EventBus.emit(name, payload);
    }
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
        this.desiredLocation = this.currentLocation;
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
    if (!res.ok) throw new Error(`visitor update failed: ${res.status}`);
    if (body.name) {
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
    const raw = await res.json();
    const snapshot = SnapshotResponse.parse(raw);
    // Cache the last good snapshot for the server-down fallback.
    this.cacheSnapshot(raw);
    this.applySnapshot(snapshot);
  }

  private async hydrateSnapshotWithRetry(attempts = 3): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.hydrateSnapshot();
        return;
      } catch (err) {
        lastError = err;
        if (attempt + 1 < attempts) {
          this.setAvailability('reconnecting');
          await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  // Emit the EventBus state for a snapshot (live or cached-replay). When
  // `cached`, the world reads as not-awake regardless — a cached snapshot is a
  // memory, the town is asleep until a live tick proves otherwise. `replayEvents`
  // is true on the initial hydrate (late joiners see the scene already in
  // motion) but FALSE on a periodic/reconnect re-sync — there the snapshot only
  // corrects authoritative agent positions/state; re-dispatching its recent
  // events would double-fire feed rows and pop stale bubbles (the live stream
  // already delivers new events).
  private applySnapshot(
    snapshot: SnapshotResponse,
    opts: { cached?: boolean; replayEvents?: boolean } = {},
  ): void {
    const { cached = false, replayEvents = true } = opts;
    // Remember it so a later scene transition can resyncScene() the new manager
    // off this state without re-hitting the network.
    this.lastSnapshot = snapshot;
    this.authoritativeAwake = cached ? null : snapshot.world.awake;

    // Initial per-agent state (positions/status/engagement). On a re-sync this
    // is the whole point: npc-status flows to every NPCManager and reconciles
    // sprites to their authoritative locations (no-op when already correct).
    for (const agent of snapshot.agents) {
      const { name, payload } = mapAgentStatus(agent);
      EventBus.emit(name, payload);
    }

    // World-level state drives the tint + sleeping flag.
    EventBus.emit('world-state', snapshot.world);
    if (cached || !snapshot.world.awake) {
      this.setAvailability(cached ? 'unavailable' : 'budget-asleep');
    } else {
      this.setAvailability('live');
    }

    // Replay recent events so late joiners see the scene already in motion —
    // but NOT the momentary ones. A phone that rang or a bit that popped 30
    // minutes ago must not re-fire the instant you arrive (the "all the effects
    // happen at once on join" bug). Positions/state already came from the
    // snapshot.agents loop above, and the feed/Chronicle fetch their own
    // history, so we skip transient animations/popups/bubbles here and let the
    // live SSE stream drive anything new from now on.
    if (replayEvents) {
      for (const ev of snapshot.recentEvents) {
        if (TRANSIENT_ON_JOIN.has(ev.type)) continue;
        this.dispatchWorldEvent(ev);
      }
    }
  }

  // Authoritative re-sync: re-read /world/snapshot and re-apply ONLY the
  // per-agent + world state (no event replay). Heals stale positions after a
  // silent SSE drop without waiting on the bounded backlog replay. Best-effort
  // and self-guarded against overlap; a failure just leaves the last state.
  private async resync(): Promise<void> {
    if (this.stopped || !this.started || this.resyncing) return;
    this.resyncing = true;
    try {
      const url = new URL(`${this.baseUrl}/world/snapshot`);
      if (this.visitorId) url.searchParams.set('visitorId', this.visitorId);
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const raw = await res.json();
      const snapshot = SnapshotResponse.parse(raw);
      this.cacheSnapshot(raw);
      this.applySnapshot(snapshot, { replayEvents: false });
    } catch {
      /* best-effort — the next resync / reconnect tries again */
    } finally {
      this.resyncing = false;
    }
  }

  // --- re-sync triggers (visibility + slow timer) ---------------------------

  private startResyncTimer(): void {
    if (typeof window === 'undefined' || this.resyncTimer) return;
    this.resyncTimer = setInterval(() => {
      // Skip while hidden — a backgrounded tab can't render anyway, and the
      // visibility handler re-syncs the moment it comes back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void this.resync();
    }, RESYNC_INTERVAL_MS);
  }

  private stopResyncTimer(): void {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') {
      this.releaseStreamLease();
      return;
    }
    // Tab refocused: EventSource may have been throttled/suspended while hidden.
    // Re-sync authoritative state, then compete for the one browser-owned stream.
    void this.resync();
    this.tryClaimStream();
  };

  private wireVisibility(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private unwireVisibility(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private cacheSnapshot(raw: unknown): void {
    try {
      this.writeStored(STORAGE_KEYS.snapshot, JSON.stringify(raw));
    } catch {
      /* quota / private mode — caching is best-effort */
    }
  }

  // Replay the last cached snapshot (server-down boot). Silent on miss / parse
  // failure — the town just dreams empty + the feed loads whatever it can.
  private replayCachedSnapshot(): void {
    const stored = this.readStored(STORAGE_KEYS.snapshot);
    if (!stored) return;
    try {
      const snapshot = SnapshotResponse.parse(JSON.parse(stored));
      this.applySnapshot(snapshot, { cached: true });
    } catch {
      /* stale/incompatible cache — ignore */
    }
  }

  // --- cross-tab stream ownership -----------------------------------------

  private startStreamCoordination(): void {
    if (typeof window === 'undefined') return;
    const identity = this.visitorId ?? 'observer';
    this.streamLeaseKey = `town.worldStreamLease.${identity}`;
    if ('BroadcastChannel' in window) {
      this.streamChannel = new BroadcastChannel(`town.worldStream.${identity}`);
      this.streamChannel.onmessage = (message: MessageEvent<StreamChannelMessage>) => {
        const data = message.data;
        if (!data || data.sender === this.tabId) return;
        if (data.kind === 'event') {
          const parsed = WorldEvent.safeParse(data.event);
          if (parsed.success) this.dispatchWorldEvent(parsed.data, false);
        } else if (data.kind === 'availability') {
          // A sibling's stream proves transport health, not that this tab has a
          // complete snapshot. Heal first if our own boot hydration failed.
          if (data.state === 'live' && !this.lastSnapshot) void this.resync();
          else this.setAvailability(data.state, false);
        } else if (data.kind === 'released' && this.isVisible()) {
          this.scheduleStreamClaim(50);
        }
      };
    }
    if (this.isVisible()) this.tryClaimStream();
  }

  private stopStreamCoordination(): void {
    this.releaseStreamLease();
    if (this.streamClaimTimer) {
      clearTimeout(this.streamClaimTimer);
      this.streamClaimTimer = null;
    }
    if (this.streamChannel) {
      this.streamChannel.close();
      this.streamChannel = null;
    }
  }

  private isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }

  private tryClaimStream(): void {
    if (this.stopped || !this.isVisible() || !this.streamLeaseKey) return;
    // BroadcastChannel-less browsers retain the hidden-tab protection and use
    // their own stream; modern browsers take the shared-lease path below.
    if (!this.streamChannel) {
      this.streamOwner = true;
      if (!this.eventSource && !this.reconnectTimer) this.openStream();
      return;
    }
    const now = Date.now();
    let lease: { owner?: string; expires?: number } | null = null;
    try {
      lease = JSON.parse(localStorage.getItem(this.streamLeaseKey) ?? 'null');
    } catch {
      lease = null;
    }
    if (lease?.owner && lease.owner !== this.tabId && (lease.expires ?? 0) > now) {
      this.streamOwner = false;
      this.closeStream();
      this.scheduleStreamClaim(Math.max(500, Math.min(5_000, (lease.expires ?? now) - now + 50)));
      return;
    }
    try {
      localStorage.setItem(
        this.streamLeaseKey,
        JSON.stringify({ owner: this.tabId, expires: now + STREAM_LEASE_MS }),
      );
      const verified = JSON.parse(localStorage.getItem(this.streamLeaseKey) ?? 'null') as {
        owner?: string;
      } | null;
      if (verified?.owner !== this.tabId) {
        this.scheduleStreamClaim(1_000);
        return;
      }
    } catch {
      // Storage unavailable: still keep exactly one stream within this tab.
    }
    this.streamOwner = true;
    if (!this.streamLeaseTimer) {
      this.streamLeaseTimer = setInterval(() => this.renewStreamLease(), STREAM_LEASE_RENEW_MS);
    }
    if (!this.eventSource && !this.reconnectTimer) this.openStream();
  }

  private renewStreamLease(): void {
    if (!this.streamOwner || !this.streamLeaseKey || !this.isVisible()) {
      this.releaseStreamLease();
      return;
    }
    try {
      const lease = JSON.parse(localStorage.getItem(this.streamLeaseKey) ?? 'null') as {
        owner?: string;
      } | null;
      if (lease?.owner && lease.owner !== this.tabId) {
        this.streamOwner = false;
        this.closeStream();
        this.scheduleStreamClaim(STREAM_LEASE_RENEW_MS);
        return;
      }
      localStorage.setItem(
        this.streamLeaseKey,
        JSON.stringify({ owner: this.tabId, expires: Date.now() + STREAM_LEASE_MS }),
      );
    } catch {
      /* storage is best-effort; this tab remains its own owner */
    }
  }

  private releaseStreamLease(): void {
    this.closeStream();
    if (this.streamLeaseTimer) {
      clearInterval(this.streamLeaseTimer);
      this.streamLeaseTimer = null;
    }
    if (this.streamClaimTimer) {
      clearTimeout(this.streamClaimTimer);
      this.streamClaimTimer = null;
    }
    if (this.streamOwner && this.streamLeaseKey) {
      try {
        const lease = JSON.parse(localStorage.getItem(this.streamLeaseKey) ?? 'null') as {
          owner?: string;
        } | null;
        if (lease?.owner === this.tabId) localStorage.removeItem(this.streamLeaseKey);
      } catch {
        /* best-effort */
      }
      this.streamChannel?.postMessage({ kind: 'released', sender: this.tabId } satisfies StreamChannelMessage);
    }
    this.streamOwner = false;
  }

  private scheduleStreamClaim(delay: number): void {
    if (this.streamClaimTimer || this.stopped) return;
    this.streamClaimTimer = setTimeout(() => {
      this.streamClaimTimer = null;
      this.tryClaimStream();
    }, delay);
  }

  // --- SSE firehose (GET /events/stream, EventSource) -----------------------

  private openStream(): void {
    if (this.stopped || typeof window === 'undefined' || !('EventSource' in window)) return;
    if (this.streamChannel && !this.streamOwner) return;
    // Defense in depth: never leak a prior connection (reconnect paths / any
    // double-invoke). closeStream() also clears a pending reconnect timer.
    this.closeStream();
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
      this.setTransportAvailability(true);
      // A re-open after the first connection is a reconnect (our backoff path OR
      // EventSource's own silent auto-reconnect after a Railway edge recycle).
      // The backlog replay only covers a bounded window, so re-hydrate the
      // snapshot to correct any positions/state that drifted during the gap.
      if (this.hasConnectedOnce) {
        void this.resync();
      }
      this.hasConnectedOnce = true;
    };

    // The server writes every frame as a NAMED event (`event: agent.moved` …),
    // and EventSource only fires `onmessage` for UN-named frames — a named
    // event needs its own addEventListener or it is silently dropped. This was
    // the "agents only move after a refresh" bug: live frames never dispatched;
    // the snapshot's recentEvents replay on load did all the visible work.
    const onFrame = (msg: MessageEvent) => this.handleStreamMessage(msg);
    for (const type of worldEventTypes) {
      es.addEventListener(type, onFrame);
    }
    // Un-named frames (defensive: any future server change back to default
    // frames keeps working) — heartbeats are named, so this is quiet today.
    es.onmessage = onFrame;

    es.onerror = () => {
      this.setTransportAvailability(false);
      // Close even while EventSource says CONNECTING. A 429 response otherwise
      // invokes its opaque automatic retry loop, bypassing our backoff entirely.
      es.close();
      if (this.eventSource === es) this.eventSource = null;
      this.scheduleReconnect();
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

  private dispatchWorldEvent(ev: WorldEvent, broadcast = true): void {
    this.patchSnapshot(ev);
    EventBus.emit('world-event', ev);
    for (const { name, payload } of mapWorldEvent(ev)) {
      EventBus.emit(name, payload);
    }
    if (broadcast && this.streamOwner) {
      this.streamChannel?.postMessage({
        kind: 'event',
        sender: this.tabId,
        event: ev,
      } satisfies StreamChannelMessage);
    }
  }

  // Keep the cached snapshot's per-agent state LIVE as events stream in.
  // resyncScene() replays this cache into every fresh NPCManager on a scene
  // transition — without patching, agents respawn at their boot-time positions
  // (observed live: Builder walked to the office mid-chat, the visitor followed
  // through the door, and the office scene spawned him back in the workshop —
  // i.e. nowhere — so neither the sprite nor his speech bubble ever appeared).
  private patchSnapshot(ev: WorldEvent): void {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return;
    if (ev.type === 'agent.moved') {
      const agent = snapshot.agents.find((a) => a.id === ev.payload.agent);
      if (agent) agent.locationId = ev.payload.to;
    } else if (ev.type === 'agent.activity') {
      const agent = snapshot.agents.find((a) => a.id === ev.payload.agent);
      if (agent) agent.activity = ev.payload.activity;
    } else if (ev.type === 'world.time') {
      snapshot.world.phase = ev.payload.phase;
    }
  }

  private scheduleReconnect(): void {
    this.closeStream();
    if (this.stopped || !this.streamOwner || !this.isVisible()) return;
    this.setTransportAvailability(false);
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

  private setAvailability(
    state: 'live' | 'reconnecting' | 'budget-asleep' | 'unavailable',
    broadcast = true,
  ): void {
    EventBus.emit('world-availability', { state });
    if (broadcast && this.streamOwner) {
      this.streamChannel?.postMessage({
        kind: 'availability',
        sender: this.tabId,
        state,
      } satisfies StreamChannelMessage);
    }
  }

  private setTransportAvailability(connected: boolean): void {
    this.setAvailability(availabilityForTransport(this.authoritativeAwake, connected));
  }

  // --- location reporting (PATCH on scene change) ---------------------------

  // Called by App on `scene-changed`. Reports the visitor's logical location so
  // co-located agents perceive the arrival (design doc §2).
  reportLocation(locationId: LocationId): void {
    if (this.observe) return;
    if (locationId === this.desiredLocation && locationId === this.currentLocation) return;
    this.desiredLocation = locationId;
    this.locationPatch = this.locationPatch.then(async () => {
      try {
        await this.patchVisitor({ locationId });
        this.currentLocation = locationId;
      } catch {
        // Keep canonical and desired state distinct. The next report or chat
        // open retries instead of suppressing a location the server never saw.
      }
    });
  }

  // --- fixture interaction (POST /visitors/:id/interact) --------------------

  interact(locationId: LocationId, fixture: string): void {
    if (this.observe || !this.visitorId) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.visitorToken) headers['x-visitor-token'] = this.visitorToken;
    void fetch(`${this.baseUrl}/visitors/${encodeURIComponent(this.visitorId)}/interact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ locationId, fixture }),
    }).catch(() => undefined);
  }

  // --- chat lifecycle -------------------------------------------------------

  // The single chat entry point (M2.1): the visitor speaks first — there is no
  // greeting. Sends are always enqueued, then one drain loop creates/reuses the
  // correct session and streams every visitor line in FIFO order.
  async sendMessage(agentId: ThomasId, text: string): Promise<void> {
    if (this.observe) return;
    if (!text.trim()) return;

    this.pendingMessages.enqueue({ agentId, text });
    await this.drainPendingMessages();
  }

  private async drainPendingMessages(): Promise<void> {
    if (this.drainingMessages) return;
    this.drainingMessages = true;
    try {
      for (;;) {
        const message = this.pendingMessages.dequeue();
        if (!message) break;

        if (!this.activeChat) {
          const opened = await this.openSession(message.agentId);
          if (!opened) continue; // openSession surfaced the error
        }

        const chat = this.activeChat;
        if (!chat) continue;
        // A queued line keeps its text, but not authority to re-invite someone
        // who left during an earlier reply. Retarget it to the canonical room.
        const addressed = chat.participants.includes(message.agentId)
          ? message.agentId
          : chat.participants.includes(chat.primaryAgent)
            ? chat.primaryAgent
            : chat.participants[0];
        if (!addressed) continue;
        chat.primaryAgent = addressed;
        await this.streamTurn(
          `${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/messages`,
          { text: message.text, to: addressed }
        );
      }
    } finally {
      this.drainingMessages = false;
    }
  }

  // Create a session for an agent (POST /chats). Closes any prior session first
  // (one body, one conversation). Returns true iff a session is now active.
  private async openSession(agentId: ThomasId): Promise<boolean> {
    if (!this.visitorId) {
      EventBus.emit('chat-error', { npcId: agentId, reason: 'not-connected' });
      return false;
    }
    // A region transition and an immediate SPACE press can otherwise race: the
    // chat POST reaches the server before the visitor's canonical location.
    await this.locationPatch;
    if (this.desiredLocation && this.currentLocation !== this.desiredLocation) {
      try {
        await this.patchVisitor({ locationId: this.desiredLocation });
        this.currentLocation = this.desiredLocation;
      } catch {
        EventBus.emit('chat-error', { npcId: agentId, reason: 'not-connected' });
        return false;
      }
    }
    this.closeActiveChat({ clearPending: false });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chats`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.visitorToken ? { 'x-visitor-token': this.visitorToken } : {}),
        },
        body: JSON.stringify({ agentId, visitorId: this.visitorId }),
      });
    } catch {
      EventBus.emit('chat-error', { npcId: agentId, reason: 'server-down' });
      return false;
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      EventBus.emit('chat-error', {
        npcId: agentId,
        reason: body.reason === 'not-co-located' ? 'not-co-located' : 'engaged',
      });
      return false;
    }
    if (!res.ok) {
      EventBus.emit('chat-error', { npcId: agentId, reason: `error-${res.status}` });
      return false;
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
      streamSettled: true,
      seenMessageIds: new Set(),
    };
    this.startPing();
    EventBus.emit('chat-opened', {
      npcId: agentId,
      sessionId: session.sessionId,
      participants: session.participants,
    });
    EventBus.emit('chat-participants', {
      sessionId: session.sessionId,
      participants: session.participants,
      addressed: agentId,
    });
    // Show the visitor where they left off. Fire-and-forget: history is a nicety
    // and must never delay or block the panel opening.
    void this.loadChatHistory(agentId, session.sessionId);
    return true;
  }

  async addressChat(agentId: ThomasId): Promise<boolean> {
    const chat = this.activeChat;
    if (!chat) return true;
    if (!chat.participants.includes(agentId) && !(await this.joinChatParticipant(agentId))) {
      return false;
    }
    if (this.activeChat !== chat || !chat.participants.includes(agentId)) return false;
    chat.primaryAgent = agentId;
    EventBus.emit('chat-participants', {
      sessionId: chat.sessionId,
      participants: chat.participants,
      addressed: agentId,
    });
    return true;
  }

  private async joinChatParticipant(agentId: ThomasId): Promise<boolean> {
    const chat = this.activeChat;
    if (!chat) return false;
    try {
      const res = await fetch(
        `${this.baseUrl}/chats/${encodeURIComponent(chat.sessionId)}/participants`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-token': chat.sessionToken,
          },
          body: JSON.stringify({ agentId }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        if (this.activeChat === chat) {
          EventBus.emit('chat-error', {
            npcId: agentId,
            sessionId: chat.sessionId,
            reason: body.reason ?? `error-${res.status}`,
          });
        }
        return false;
      }
      const joined = JoinChatResponse.parse(await res.json());
      if (this.activeChat !== chat) return false;
      chat.participants = joined.participants;
      EventBus.emit('chat-participants', {
        sessionId: chat.sessionId,
        participants: joined.participants,
        addressed: agentId,
      });
      return true;
    } catch {
      if (this.activeChat === chat) {
        EventBus.emit('chat-error', {
          npcId: agentId,
          sessionId: chat.sessionId,
          reason: 'server-down',
        });
      }
      return false;
    }
  }

  // Shared POST-SSE turn streamer: fetch + ReadableStream parse of
  // ChatStreamFrames (design doc §5 transport). The `type` field discriminates.
  private async streamTurn(url: string, body: Record<string, unknown>): Promise<void> {
    const chat = this.activeChat;
    if (!chat) return;
    const requestId = crypto.randomUUID();
    const abort = new AbortController();
    chat.abort = abort;
    chat.streamSettled = false;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': chat.sessionToken,
        },
        body: JSON.stringify({ ...body, requestId }),
        signal: abort.signal,
      });
    } catch {
      if (this.activeChat === chat && chat.abort === abort) chat.abort = null;
      EventBus.emit('chat-error', { npcId: chat.primaryAgent, reason: 'stream-failed' });
      return;
    }

    if (!res.ok || !res.body) {
      if (this.activeChat === chat && chat.abort === abort) chat.abort = null;
      const errorBody = (await res.json().catch(() => ({}))) as { reason?: string };
      EventBus.emit('chat-error', {
        npcId: chat.primaryAgent,
        reason: errorBody.reason === 'not-co-located' ? 'not-co-located' : `error-${res.status}`,
      });
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
          this.handleChatFrame(chat, msg.data);
        }
      }
    } catch {
      // Aborted (new turn / close) or network drop — silent; panel keeps state.
    } finally {
      // Clear the abort only if it's still ours (a chat_ended frame may have
      // torn the session down mid-stream).
      if (this.activeChat === chat && chat.abort === abort) chat.abort = null;
    }

    // The stream ended without its terminal frame and wasn't aborted by us →
    // the proxy killed it mid-turn (observed with long memory/tool rounds: the
    // panel got `memory_recalled`, never the text). The turn almost always
    // completes server-side — poll the transcript and surface the reply.
    if (!chat.streamSettled && !abort.signal.aborted && this.activeChat === chat) {
      await this.recoverDroppedTurn(chat, requestId);
    }

  }

  private handleChatFrame(chat: ActiveChat, data: string): void {
    if (this.activeChat !== chat) return;
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
        // Reply chips removed (and the server no longer generates them); the
        // case stays so the frame union remains exhaustively handled.
        break;

      case 'done': {
        // `agent` may be absent on single-agent turns; fall back to primary.
        const agent: ThomasId = frame.agent ?? chat.primaryAgent;
        const text = chat.turnText.get(agent) ?? '';
        chat.turnText.delete(agent);
        chat.seenMessageIds.add(frame.messageId);
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

      case 'participants':
        chat.participants = frame.participants;
        if (!chat.participants.includes(chat.primaryAgent)) {
          chat.primaryAgent = chat.participants[0];
        }
        EventBus.emit('chat-participants', {
          sessionId: chat.sessionId,
          participants: frame.participants,
          addressed: chat.primaryAgent,
        });
        break;

      case 'response_done':
        chat.streamSettled = true;
        EventBus.emit('chat-response-done', { sessionId: chat.sessionId });
        break;

      case 'action':
        // The agent ran a tool mid-chat (walked, made something). Surface it as
        // a diegetic action line; the agent.moved stream walks the sprite.
        EventBus.emit('chat-action', {
          npcId: frame.agent,
          sessionId: chat.sessionId,
          tool: frame.tool,
          detail: frame.detail,
        });
        break;

      case 'share_card':
        // The agent dropped a concrete card (artifact / reference / proof) — the
        // panel renders it inline as a distinct line.
        EventBus.emit('chat-share-card', {
          npcId: frame.agent,
          sessionId: chat.sessionId,
          card: frame.card,
        });
        break;

      case 'chat_ended':
        // The agent ended the chat itself — the server already closed the
        // session, so tear down ping/activeChat WITHOUT a POST /close. Emit
        // chat-ended so the panel shows the goodbye + [wave goodbye] button.
        chat.streamSettled = true;
        EventBus.emit('chat-ended', {
          npcId: frame.agent,
          sessionId: chat.sessionId,
          reason: frame.reason ?? null,
        });
        this.teardownActiveChat();
        break;

      default: {
        const _never: never = frame;
        void _never;
      }
    }
  }

  // Recovery for a mid-turn stream kill: replay every unseen agent row, but do
  // not settle the visitor input until its durable response boundary is marked
  // complete. The boundary is essential when the second facet silently passes.
  private async recoverDroppedTurn(chat: ActiveChat, requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2_000 : 5_000));
      if (this.activeChat !== chat) return; // closed / retargeted meanwhile
      const transcript = await this.rehydrateChat(chat.sessionId, chat.sessionToken);
      if (!transcript) continue;
      chat.participants = transcript.participants;
      const unseen = transcript.messages.filter(
        (message) => message.sender !== 'visitor' && !chat.seenMessageIds.has(message.id)
      );
      for (const message of unseen) {
        const agent = message.sender as ThomasId;
        if (!chat.turnText.has(agent)) {
          chat.turnText.set(agent, '');
          EventBus.emit('chat-turn-started', { npcId: agent, sessionId: chat.sessionId });
        }
        const already = chat.turnText.get(agent) ?? '';
        const missing = message.body.startsWith(already)
          ? message.body.slice(already.length)
          : message.body;
        if (missing) {
          EventBus.emit('chat-delta', { npcId: agent, sessionId: chat.sessionId, text: missing });
        }
        chat.turnText.delete(agent);
        for (const card of message.attachments ?? []) {
          EventBus.emit('chat-share-card', { npcId: agent, sessionId: chat.sessionId, card });
        }
        chat.seenMessageIds.add(message.id);
        EventBus.emit('chat-turn-done', {
          npcId: agent,
          sessionId: chat.sessionId,
          messageId: message.id,
        });
        EventBus.emit('npc-chat-response', {
          sender: agent,
          senderName: NPC_CONFIGS[agent]?.displayName ?? agent,
          text: message.body,
          timestamp: Date.now(),
        });
      }
      EventBus.emit('chat-participants', {
        sessionId: chat.sessionId,
        participants: chat.participants,
        addressed: chat.primaryAgent,
      });
      const response = transcript.responses.find((item) => item.requestId === requestId);
      if (response?.completed) {
        chat.streamSettled = true;
        EventBus.emit('chat-response-done', { sessionId: chat.sessionId });
        return;
      }
    }
    // Six polls (~27s) with nothing new — let the visitor know rather than
    // leaving a silently hung bubble.
    EventBus.emit('chat-error', { npcId: chat.primaryAgent, reason: 'stream-failed' });
  }

  // GET /visitors/:id/chat-history?agent= — the visitor's earlier messages with
  // this facet, from BEFORE this session.
  //
  // Why this is separate from rehydrateChat below: that one recovers the CURRENT
  // session after a dropped stream and needs the session token, which lives only
  // in memory. So a page reload — or just switching facets and coming back —
  // left the panel blank even though the agent remembers the visitor perfectly
  // well. That mismatch is what made continuity feel broken: the facet greets you
  // as someone it has talked to nine times, above an empty transcript.
  private async loadChatHistory(agentId: ThomasId, excludeSessionId: string): Promise<void> {
    if (!this.visitorId || !this.visitorToken) return;
    try {
      const url =
        `${this.baseUrl}/visitors/${encodeURIComponent(this.visitorId)}/chat-history` +
        `?agent=${encodeURIComponent(agentId)}&exclude=${encodeURIComponent(excludeSessionId)}`;
      const res = await fetch(url, { headers: { 'x-visitor-token': this.visitorToken } });
      if (!res.ok) return;
      const parsed = ChatHistoryResponse.parse(await res.json());
      if (parsed.messages.length === 0) return;
      // The panel may have been closed again while this was in flight.
      if (this.activeChat?.primaryAgent !== agentId) return;
      EventBus.emit('chat-history', {
        npcId: agentId,
        lastAt: parsed.lastAt,
        messages: parsed.messages.map((m) => ({
          sender: m.sender as 'visitor' | ThomasId,
          senderName:
            m.sender === 'visitor'
              ? 'You'
              : (NPC_CONFIGS[m.sender]?.displayName ?? m.sender),
          text: m.body,
          timestamp: new Date(m.ts).getTime(),
        })),
      });
    } catch {
      /* history is a nicety — never surface a failure to fetch it */
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

  // Visitor-initiated teardown: tells the server to close the session (POST
  // /close), aborts any in-flight stream, and clears local state.
  private closeActiveChat({ clearPending = true }: { clearPending?: boolean } = {}): void {
    const chat = this.activeChat;
    if (!this.teardownActiveChat(clearPending)) return;
    void fetch(`${this.baseUrl}/chats/${encodeURIComponent(chat!.sessionId)}/close`, {
      method: 'POST',
      headers: { 'x-session-token': chat!.sessionToken },
    }).catch(() => undefined);
  }

  // Local teardown WITHOUT a POST /close — used when the server already ended
  // the session (a chat_ended frame). Clears ping/abort/queue/activeChat.
  // Returns true iff there was an active chat to tear down.
  private teardownActiveChat(clearPending = true): boolean {
    if (clearPending) this.pendingMessages.clear();
    const chat = this.activeChat;
    if (!chat) return false;
    this.activeChat = null;
    if (chat.pingTimer) clearInterval(chat.pingTimer);
    if (chat.abort) chat.abort.abort();
    return true;
  }

  // --- pagehide: best-effort close via sendBeacon ---------------------------

  private onPageHide = () => {
    this.releaseStreamLease();
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
