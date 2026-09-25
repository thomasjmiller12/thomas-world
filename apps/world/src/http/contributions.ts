import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ArtifactRevisionResponse, ArtifactTrailResponse, CreateContributionRequest, CreateContributionResponse } from "@town/contract";
import { artifactTrail, ContributionError, createContribution, getArtifactRevision } from "../engine/contributions.js";
import { getArtifact } from "../engine/artifacts.js";
import { visitorTokenValid } from "../engine/visitors.js";

export function contributionRoutes() {
  const app = new Hono();
  app.get("/artifacts/:id/trail", async (c) => {
    if (!await getArtifact(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const visitorId = c.req.query("visitorId");
    const authenticated = visitorId && await visitorTokenValid(visitorId, c.req.header("x-visitor-token"));
    if (visitorId && !authenticated) return c.json({ error: "unauthorized" }, 401);
    c.header("Cache-Control", "private, no-store");
    return c.json(ArtifactTrailResponse.parse(await artifactTrail(c.req.param("id"), authenticated ? visitorId : undefined)));
  });
  app.get("/artifacts/:id/revisions/:revisionId", async (c) => {
    const revision = await getArtifactRevision(c.req.param("id"), c.req.param("revisionId"));
    if (!revision) return c.json({ error: "not found" }, 404);
    return c.json(ArtifactRevisionResponse.parse({ revision }));
  });
  app.post("/artifacts/:id/contributions", bodyLimit({ maxSize: 16_384 }), async (c) => {
    const parsed = CreateContributionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid contribution", message: "Write a suggestion between 1 and 2,000 characters." }, 400);
    if (!await visitorTokenValid(parsed.data.visitorId, c.req.header("x-visitor-token"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      const result = await createContribution(c.req.param("id"), parsed.data);
      return c.json(CreateContributionResponse.parse(result), result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ContributionError) return c.json({ error: error.message, message: error.message }, error.status);
      throw error;
    }
  });
  return app;
}
