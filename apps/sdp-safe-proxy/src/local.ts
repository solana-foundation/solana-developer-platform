import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createLocalCallerCheck } from "./caller";
import { parseLocalSettings, platformCredentials } from "./settings";

// The local entry trusts a caller that names itself, so it never runs on Cloud Run.
if (process.env.K_SERVICE !== undefined) {
  throw new Error("the local entry does not run on Cloud Run: K_SERVICE is set");
}

const settings = parseLocalSettings(process.env);
const listensOn = { hostname: "127.0.0.1", port: settings.SDP_SAFE_PROXY_PORT };

const app = createApp({
  identifyCaller: createLocalCallerCheck(listensOn),
  credentials: platformCredentials(settings),
  fetch: globalThis.fetch,
  providerTimeoutMs: settings.SAFE_PROXY_PROVIDER_TIMEOUT_MS,
  writeLog: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  revision: "local",
});

const server = serve({ fetch: app.fetch, ...listensOn });
process.on("SIGTERM", () => server.close());
