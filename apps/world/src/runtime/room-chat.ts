import type { AgentId, ChatStreamFrame } from "@town/contract";
import { getVisitor } from "../engine/visitors.js";
import {
  appendVisitorLine,
  chatParticipantsCoLocated,
  completeVisitorResponse,
  endSession,
  getSession,
  lastActiveAgentSpeaker,
  leaveSession,
  sanitizeVisitorText,
} from "./chat.js";
import { enqueue } from "./queue.js";
import { withRoomLock } from "./room-lock.js";
import type { TurnHandlers } from "./turn.js";

export function chooseRoomSpeaker(
  participants: AgentId[],
  requested: AgentId | undefined,
  lastSpeaker: AgentId | undefined,
  text: string,
): AgentId {
  if (requested && participants.includes(requested)) return requested;
  const named = participants.find((agentId) =>
    new RegExp(`\\b${agentId}(?:\\s+thomas)?\\b`, "i").test(text),
  );
  if (named) return named;
  if (lastSpeaker && participants.includes(lastSpeaker)) return lastSpeaker;
  return participants[0];
}

async function reconcileRoom(
  sessionId: string,
  handlers: TurnHandlers,
): Promise<Awaited<ReturnType<typeof getSession>>> {
  let session = await getSession(sessionId);
  if (!session) return null;
  for (const agentId of session.participants) {
    if (await chatParticipantsCoLocated(agentId, session.visitorId)) continue;
    const left = await leaveSession(sessionId, agentId);
    if (left.ended) {
      await handlers.onFrame({
        type: "chat_ended",
        agent: agentId,
        reason: "you are no longer in the same place",
      });
      return null;
    }
    await handlers.onFrame({ type: "participants", participants: left.participants });
    session = await getSession(sessionId);
    if (!session) return null;
  }
  return session;
}

export function isSilentInterjection(frames: ChatStreamFrame[]): boolean {
  const text = frames
    .filter((frame): frame is Extract<ChatStreamFrame, { type: "text" }> => frame.type === "text")
    .map((frame) => frame.text)
    .join("")
    .trim();
  return /^\[pass\][.!]?$/i.test(text);
}

export async function runRoomResponse(args: {
  sessionId: string;
  visitorId: string;
  text: string;
  requestId: string;
  to?: AgentId;
  handlers: TurnHandlers;
}): Promise<void> {
  // The browser is only a view onto a durable response. A dead transport must
  // never abort the agent before its transcript/native thread are persisted.
  let streamOpen = true;
  const handlers: TurnHandlers = {
    onFrame: async (frame) => {
      if (!streamOpen) return;
      try {
        await args.handlers.onFrame(frame);
      } catch {
        streamOpen = false;
      }
    },
  };
  await withRoomLock(args.sessionId, async () => {
    let visitorLinePersisted = false;
    try {
      let session = await reconcileRoom(args.sessionId, handlers);
      if (!session || session.visitorId !== args.visitorId) return;
      const visitor = await getVisitor(args.visitorId);
      if (!visitor) {
        await endSession(args.sessionId);
        await handlers.onFrame({
          type: "chat_ended",
          agent: session.agentId,
          reason: "the visitor has left",
        });
        return;
      }
      const text = sanitizeVisitorText(args.text);
      if (!text) return;
      const visitorMessageId = await appendVisitorLine(args.sessionId, text, args.requestId);
      visitorLinePersisted = true;
      const lastSpeaker = await lastActiveAgentSpeaker(args.sessionId, session.participants);
      const first = chooseRoomSpeaker(session.participants, args.to, lastSpeaker, text);

      await enqueue(first, {
        kind: "visitor",
        sessionId: args.sessionId,
        visitorId: args.visitorId,
        visitorName: visitor.name,
        text,
        visitorMessageId,
        mode: "direct",
        roomParticipants: session.participants,
        handlers,
      });

      session = await reconcileRoom(args.sessionId, handlers);
      const second = session?.participants.find((agentId) => agentId !== first);
      if (session && second) {
        const buffered: ChatStreamFrame[] = [];
        const interjection = await enqueue(second, {
          kind: "visitor",
          sessionId: args.sessionId,
          visitorId: args.visitorId,
          visitorName: visitor.name,
          text,
          visitorMessageId,
          mode: "interject",
          roomParticipants: session.participants,
          handlers: { onFrame: (frame) => void buffered.push(frame) },
        });
        if (interjection.ran && interjection.reason === "ok" && !isSilentInterjection(buffered)) {
          for (const frame of buffered) await handlers.onFrame(frame);
        }
      }
    } finally {
      // Persist the whole-response boundary before streaming it. Recovery can
      // now distinguish a silent [pass] from an interjection still in flight.
      if (visitorLinePersisted) {
        await completeVisitorResponse(args.sessionId, args.requestId).catch((error) =>
          console.warn(
            `[room-chat] could not persist completion ${args.sessionId}/${args.requestId}:`,
            (error as Error).message,
          ),
        );
      }
      await handlers.onFrame({ type: "response_done" });
    }
  });
}
