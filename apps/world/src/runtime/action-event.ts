import type { AgentId } from "@town/contract";
import { appendEvent } from "../engine/events.js";
import { getAgent } from "../engine/agents.js";
import type { ToolEffect, ToolResult } from "./llm/tool.js";

export interface RelatedActionId {
  kind: "agent" | "artifact" | "location" | "message" | "object" | "request" | "session" | "visitor";
  id: string;
}

function record(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function stringAt(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Public action copy is deliberately derived from the tool name, never from
// arbitrary arguments or results. DM bodies, memory text, email subjects, and
// private note paths must not leak into the world event log.
export function actionSummary(tool: string, args: unknown): string {
  const input = record(args);
  const kind = stringAt(input, "kind")?.replace(/_/g, " ");
  switch (tool) {
    case "move_to":
      return "moved through town";
    case "invite_visitor":
      return "brought a visitor along";
    case "set_activity":
      return "changed what they were doing";
    case "leave_note":
      return "left a note in the world";
    case "play_beat":
      return "played a bit in the world";
    case "send_dm":
      return "sent a private note to another facet";
    case "broadcast":
      return "shared news with the other facets";
    case "create_artifact":
      return `made${kind ? ` a ${kind}` : " something"}`;
    case "edit_artifact":
      return "revised an artifact";
    case "post_bulletin":
      return "posted a bulletin";
    case "publish_blog_post":
      return "published a blog post";
    case "build_interactive":
      return "built an interactive";
    case "mount_artifact":
      return "mounted an artifact in the world";
    case "place_object":
      return "placed an object in the world";
    case "move_object":
      return "repositioned an object in the world";
    case "remove_object":
      return "removed an object from the world";
    case "write_artifact_state":
      return "updated an interactive";
    case "remember":
      return "saved a memory";
    case "write_agent_note":
      return "updated a private working note";
    case "email_thomas":
      return "sent mail to P-Thomas";
    case "request_capability":
      return "asked P-Thomas for a new capability";
    case "read_mail":
      return "read outside mail";
    default:
      return `used ${tool.replace(/_/g, " ")}`;
  }
}

// Typed entity handles make later Chronicle/story grouping possible without
// copying raw tool input into the public event. Only identifiers already safe
// to expose on town surfaces are included.
export function relatedActionIds(tool: string, args: unknown): RelatedActionId[] {
  const input = record(args);
  const related: RelatedActionId[] = [];
  const add = (kind: RelatedActionId["kind"], id: string | undefined) => {
    if (id && !related.some((item) => item.kind === kind && item.id === id)) {
      related.push({ kind, id });
    }
  };

  if (tool === "move_to" || tool === "invite_visitor") {
    add("location", stringAt(input, "location"));
  }
  if (tool === "send_dm") add("agent", stringAt(input, "agent"));

  const artifactTools = new Set([
    "edit_artifact",
    "mount_artifact",
    "publish_blog_post",
    "write_artifact_state",
  ]);
  if (artifactTools.has(tool)) {
    add("artifact", stringAt(input, "artifact_id") ?? stringAt(input, "id"));
  }

  add("object", stringAt(input, "object_id") ?? stringAt(input, "objectId"));
  add("visitor", stringAt(input, "visitor_id") ?? stringAt(input, "visitorId"));
  add("message", stringAt(input, "message_id") ?? stringAt(input, "messageId"));
  add("request", stringAt(input, "request_id") ?? stringAt(input, "requestId"));
  add("session", stringAt(input, "session_id") ?? stringAt(input, "sessionId"));
  return related;
}

export async function emitAgentActed(input: {
  actionId: string;
  agentId: AgentId;
  tool: string;
  effect: Exclude<ToolEffect, "read">;
  args: unknown;
  result: ToolResult;
}): Promise<void> {
  // `result` is accepted to keep the successful tool result in this boundary,
  // but intentionally never serialized; it may contain private prose.
  void input.result;
  const relatedIds = relatedActionIds(input.tool, input.args);
  const agent = await getAgent(input.agentId).catch(() => undefined);
  await appendEvent({
    type: "agent.acted",
    agentId: input.agentId,
    locationId: agent?.locationId ?? null,
    visibility: "public",
    payload: {
      agent: input.agentId,
      tool: input.tool,
      effect: input.effect,
      summary: actionSummary(input.tool, input.args),
      actionId: input.actionId,
      ...(relatedIds.length ? { relatedIds } : {}),
    },
  });
}
