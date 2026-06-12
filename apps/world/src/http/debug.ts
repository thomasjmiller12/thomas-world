// Dead-simple server-rendered /debug page (brief). No framework, no auth (M1;
// bind-private later). Shows agent states, spend today, and the recent feed —
// "read the day" without psql.

import type { SnapshotResponse } from "@town/contract";
import type { FeedRow } from "../engine/feed.js";
import { featureSummary } from "../config.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface DebugData {
  snapshot: SnapshotResponse;
  agents: {
    id: string;
    displayName: string;
    locationId: string;
    status: string;
    activity: string | null;
    engagement: { kind: "chat" | "scene"; id: string; participants: string[] } | null;
    lastTickAt: Date | null;
  }[];
  spendTodayUsd: number;
  feed: FeedRow[];
}

export function renderDebugPage(d: DebugData): string {
  const agentRows = d.agents
    .map(
      (a) => `<tr>
        <td>${esc(a.displayName)}</td>
        <td>${esc(a.locationId)}</td>
        <td>${esc(a.status)}</td>
        <td>${esc(a.activity ?? "—")}</td>
        <td>${a.engagement ? esc(`${a.engagement.kind}`) : "free"}</td>
        <td>${a.lastTickAt ? esc(a.lastTickAt.toISOString()) : "never"}</td>
      </tr>`,
    )
    .join("");

  const feedRows = d.feed
    .map((f) => `<li><span class="ts">${esc(f.ts)}</span> ${esc(f.line)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Thomas's Town — debug</title>
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:#2B2620; color:#F7F1E6; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { opacity:.7; margin:0 0 20px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; opacity:.8; margin:24px 0 8px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:4px 10px; border-bottom:1px solid #4a443a; }
  th { opacity:.6; font-weight:normal; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:3px 0; border-bottom:1px solid #3a352d; }
  .ts { opacity:.45; margin-right:8px; }
  .spend { font-size:16px; }
</style>
</head><body>
<h1>Thomas's Town — world server</h1>
<p class="sub">${esc(featureSummary())}</p>

<h2>Spend today</h2>
<p class="spend">$${d.spendTodayUsd.toFixed(2)}</p>

<h2>Agents</h2>
<table>
  <tr><th>agent</th><th>location</th><th>status</th><th>activity</th><th>engaged</th><th>last tick</th></tr>
  ${agentRows}
</table>

<h2>Recent feed</h2>
<ul>${feedRows || "<li>nothing yet</li>"}</ul>
</body></html>`;
}
