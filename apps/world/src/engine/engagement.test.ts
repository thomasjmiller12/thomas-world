import { describe, it, expect } from "vitest";
import { isBusy } from "./agents.js";
import { engagementToContract } from "./snapshot.js";

describe("engagement → contract derivation (design doc §3.2/§5)", () => {
  it("isBusy is the derived boolean: engaged iff engagement present", () => {
    expect(isBusy(null)).toBe(false);
    expect(isBusy(undefined)).toBe(false);
    expect(isBusy({ kind: "chat", id: "s1", participants: [] })).toBe(true);
    expect(isBusy({ kind: "scene", id: "c1", participants: ["builder"] })).toBe(true);
  });

  it("a chat engagement always includes 'visitor' in `with`", () => {
    const out = engagementToContract({ kind: "chat", id: "s1", participants: [] });
    expect(out).toEqual({ kind: "chat", with: ["visitor"] });
  });

  it("a group chat lists the other agent AND the visitor", () => {
    const out = engagementToContract({ kind: "chat", id: "s1", participants: ["researcher"] });
    expect(out).toEqual({ kind: "chat", with: ["researcher", "visitor"] });
  });

  it("a scene lists only the other agent(s) — no visitor", () => {
    const out = engagementToContract({ kind: "scene", id: "c1", participants: ["builder"] });
    expect(out).toEqual({ kind: "scene", with: ["builder"] });
  });

  it("an absent engagement maps to undefined (omitted from the contract)", () => {
    expect(engagementToContract(null)).toBeUndefined();
    expect(engagementToContract(undefined)).toBeUndefined();
  });
});
