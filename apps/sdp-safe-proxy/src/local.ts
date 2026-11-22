import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createPlatformCredentialLoader } from "./credentials";
import { assertNotOnCloudRun, identifyLocalCaller } from "./local-caller";
import { createRequestLog } from "./request-log";
import { parseLocalSettings } from "./settings";
import { exitWithMessage, settingsOrExit } from "./start-up";

try {
  assertNotOnCloudRun(process.env);
} catch (error) {
  exitWithMessage(error instanceof Error ? error.message : "the local entry cannot start");
}
const settings = settingsOrExit(parseLocalSettings);

const app = createApp({
  identifyCaller: identifyLocalCaller,
  loadCredential: createPlatformCredentialLoader({
    fireblocks: {
      apiKey: settings.FIREBLOCKS_API_KEY,
      apiSecretPem: settings.FIREBLOCKS_API_SECRET,
    },
    privy: { appId: settings.PRIVY_APP_ID, appSecret: settings.PRIVY_APP_SECRET },
  }),
  fetch: globalThis.fetch,
  now: Date.now,
  maxBudgetMs: settings.SAFE_PROXY_MAX_BUDGET_MS,
  writeRequestLog: createRequestLog(process.stdout),
  readiness: () => "ready",
  revision: "local",
});

const server = serve({
  fetch: app.fetch,
  port: settings.SDP_SAFE_PROXY_PORT,
  hostname: "127.0.0.1",
});
process.on("SIGTERM", () => server.close());
