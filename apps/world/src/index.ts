// apps/world — the world server (embodiment layer): API + SSE (and, in the
// runtime phase, the scheduler). Single Node process. Binds `::` for Railway
// private networking. Boots and serves regardless of which integrations are
// configured (env-gated; see config.featureSummary()).

import { serve } from "@hono/node-server";
import { config, featureSummary } from "./config.js";
import { createApp } from "./http/app.js";

const app = createApp();

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`world server listening on [${config.host}]:${info.port} (${config.nodeEnv})`);
    console.log(featureSummary());
  },
);
