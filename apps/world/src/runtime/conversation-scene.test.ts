import { describe, it, expect } from "vitest";
import {
  gapForLine,
  convertScene,
  getScene,
  sceneForAgent,
  GAP_MIN_MS,
  GAP_MAX_MS,
  _registerSceneForTest,
  _makeSceneStateForTest,
} from "./conversation-scene.js";

describe("gapForLine — 2–4s gap scaled by line length (design doc §3.1)", () => {
  it("an empty line gets exactly the minimum gap; a short line stays near it", () => {
    expect(gapForLine("")).toBe(GAP_MIN_MS);
    const g = gapForLine("ok");
    expect(g).toBeGreaterThanOrEqual(GAP_MIN_MS);
    expect(g).toBeLessThan(GAP_MIN_MS + 100); // within ~one char-step of the floor
  });

  it("a long line (≥200 chars) gets the maximum gap", () => {
    expect(gapForLine("x".repeat(200))).toBe(GAP_MAX_MS);
    expect(gapForLine("x".repeat(500))).toBe(GAP_MAX_MS);
  });

  it("a mid-length line lands strictly between min and max", () => {
    const g = gapForLine("x".repeat(100)); // halfway → ~midpoint
    expect(g).toBeGreaterThan(GAP_MIN_MS);
    expect(g).toBeLessThan(GAP_MAX_MS);
  });

  it("every gap is bounded to [GAP_MIN_MS, GAP_MAX_MS]", () => {
    for (const len of [0, 1, 50, 199, 200, 1000]) {
      const g = gapForLine("x".repeat(len));
      expect(g).toBeGreaterThanOrEqual(GAP_MIN_MS);
      expect(g).toBeLessThanOrEqual(GAP_MAX_MS);
    }
  });

  it("the gap is monotonic non-decreasing in line length", () => {
    expect(gapForLine("x".repeat(40))).toBeLessThanOrEqual(gapForLine("x".repeat(80)));
    expect(gapForLine("x".repeat(80))).toBeLessThanOrEqual(gapForLine("x".repeat(160)));
  });
});

describe("SceneRunner registry + convert CAS (design doc §3.1, §3.3a)", () => {
  it("convertScene returns false for an unknown conversation", () => {
    expect(convertScene("no-such-scene", "sess-1")).toBe(false);
  });

  it("the first convert wins the CAS; a second one loses", () => {
    // timer:null so convertScene flips flags + aborts WITHOUT touching the DB.
    const state = _makeSceneStateForTest("conv-cas", ["builder", "researcher"]);
    _registerSceneForTest(state);

    expect(convertScene("conv-cas", "sess-A")).toBe(true);
    expect(state.interrupted).toBe(true);
    expect(state.convertedTo).toBe("sess-A");
    expect(state.abort.signal.aborted).toBe(true);

    // Second interject loses — convertedTo already set.
    expect(convertScene("conv-cas", "sess-B")).toBe(false);
    expect(state.convertedTo).toBe("sess-A"); // unchanged
  });

  it("getScene + sceneForAgent locate a registered scene", () => {
    const state = _makeSceneStateForTest("conv-lookup", ["writer", "hobby"]);
    _registerSceneForTest(state);
    expect(getScene("conv-lookup")).toBe(state);
    expect(sceneForAgent("writer")).toBe(state);
    expect(sceneForAgent("hobby")).toBe(state);
    expect(sceneForAgent("career")).toBeUndefined();
  });

  it("converting an already-interrupted scene is refused (idempotent CAS)", () => {
    const state = _makeSceneStateForTest("conv-interrupted", ["builder", "writer"]);
    state.interrupted = true;
    _registerSceneForTest(state);
    expect(convertScene("conv-interrupted", "sess-X")).toBe(false);
  });
});
