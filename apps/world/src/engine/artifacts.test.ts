import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
const findObjectAtLocationMock = vi.fn();
const attachArtifactMock = vi.fn();

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (...args: unknown[]) => args,
  gt: (...args: unknown[]) => args,
}));

vi.mock("../db/client.js", () => {
  const artifacts = {
    id: {},
    agentId: {},
    kind: {},
    createdAt: {},
  };
  const db = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            returning() {
              return [{ objectId: null, createdAt: new Date(), updatedAt: new Date(), ...value }];
            },
          };
        },
      };
    },
  };
  return { db, schema: { artifacts } };
});

vi.mock("./events.js", () => ({
  appendEvent: (event: Record<string, unknown>) => {
    events.push(event);
    return Promise.resolve(event);
  },
}));

vi.mock("./objects.js", () => ({
  findObjectAtLocation: (...args: unknown[]) => findObjectAtLocationMock(...args),
  attachArtifact: (...args: unknown[]) => attachArtifactMock(...args),
}));

const { createArtifact } = await import("./artifacts.js");

beforeEach(() => {
  inserted.length = 0;
  events.length = 0;
  findObjectAtLocationMock.mockReset();
  attachArtifactMock.mockReset();
  attachArtifactMock.mockResolvedValue({ ok: true });
});

describe("createArtifact fixture anchoring", () => {
  it("physically attaches a default-anchored artifact to the matching world object", async () => {
    findObjectAtLocationMock.mockResolvedValue({ id: "library.bookshelf" });

    const artifact = await createArtifact({
      agentId: "researcher",
      kind: "research_note",
      title: "A field note",
      body: "Observed in the stacks.",
    });

    expect(inserted[0]).toMatchObject({
      id: artifact.id,
      locationId: "library",
      fixture: "bookshelf",
    });
    expect(findObjectAtLocationMock).toHaveBeenCalledWith("library", "bookshelf");
    expect(attachArtifactMock).toHaveBeenCalledWith(
      "library.bookshelf",
      artifact.id,
      "researcher",
    );
    expect(events[0]).toMatchObject({
      type: "artifact.created",
      payload: { artifactId: artifact.id, location: "library", fixture: "bookshelf" },
    });
  });

  it("keeps the artifact when an anchored fixture has no matching world object", async () => {
    findObjectAtLocationMock.mockResolvedValue(undefined);

    const artifact = await createArtifact({
      agentId: "builder",
      kind: "project_log",
      title: "Bench log",
      body: "A small iteration.",
    });

    expect(artifact.id).toBe(inserted[0]?.id);
    expect(findObjectAtLocationMock).toHaveBeenCalledWith("workshop", "monitor");
    expect(attachArtifactMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it("does not attempt object resolution for intentionally unanchored artifacts", async () => {
    await createArtifact({
      agentId: "writer",
      kind: "diary_entry",
      title: "Night notes",
      body: "Quietly filed.",
    });

    expect(findObjectAtLocationMock).not.toHaveBeenCalled();
    expect(attachArtifactMock).not.toHaveBeenCalled();
  });
});
