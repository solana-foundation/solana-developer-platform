import { serve } from "@hono/node-server";
import {
  createCallerIdentityVerifier,
  createGoogleIdentityKeys,
} from "@sdp/service-call/caller-identity";

import { createApp, type Readiness } from "./app";
import { createTokenCallerCheck } from "./caller";
import { createPlatformCredentialLoader } from "./credentials";
import { createRequestLog } from "./request-log";
import { parseServerSettings } from "./settings";
import { exitWithMessage, settingsOrExit } from "./start-up";

const settings = settingsOrExit(parseServerSettings);
const identityKeys = createGoogleIdentityKeys();
let readiness: Readiness = "starting";

const app = createApp({
  identifyCaller: createTokenCallerCheck({
    verify: createCallerIdentityVerifier({
      audience: settings.SAFE_PROXY_AUDIENCE,
      keys: identityKeys,
      maxTokenAgeSeconds: settings.SAFE_PROXY_MAX_TOKEN_AGE_SECONDS,
      now: Date.now,
    }),
    callerEmails: {
      api: settings.SAFE_PROXY_API_CALLER,
      cron: settings.SAFE_PROXY_CRON_CALLER,
    },
    now: Date.now,
  }),
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
  readiness: () => readiness,
  revision: settings.K_REVISION,
});

const server = serve({ fetch: app.fetch, port: settings.PORT });
process.on("SIGTERM", () => server.close());

// Ready only once the identity keys have been fetched.
try {
  await identityKeys.reload();
} catch {
  exitWithMessage("identity keys could not be fetched");
}
readiness = "ready";
