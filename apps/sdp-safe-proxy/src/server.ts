import { serve } from "@hono/node-server";
import {
  createCallerIdentityVerifier,
  createGoogleIdentityKeys,
} from "@sdp/service-call/caller-identity";
import { createApp } from "./app";
import { createTokenCallerCheck } from "./caller";
import { parseServerSettings, platformCredentials } from "./settings";

const settings = parseServerSettings(process.env);
const identityKeys = createGoogleIdentityKeys();

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
  }),
  credentials: platformCredentials(settings),
  fetch: globalThis.fetch,
  providerTimeoutMs: settings.SAFE_PROXY_PROVIDER_TIMEOUT_MS,
  writeLog: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  revision: settings.K_REVISION,
});

// The port opens only once the identity keys have been fetched.
await identityKeys.reload();
const server = serve({ fetch: app.fetch, port: settings.PORT });
process.on("SIGTERM", () => server.close());
