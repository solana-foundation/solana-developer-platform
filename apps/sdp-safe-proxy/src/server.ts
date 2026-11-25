import { serve } from "@hono/node-server";
import { IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "@sdp/metadata-server/caller";
import { createGoogleIdentityKeys } from "@sdp/metadata-server/receiver";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { createApp, googleCaller, localCaller } from "./app";
import { positiveInteger, readEnv } from "./utils";

const IDENTITY_TOKEN_LIFETIME_SECONDS = 3600;

const env = readEnv({
  FIREBLOCKS_API_KEY: z.string().min(1),
  // The key may arrive on one line with its line breaks written as `\n`.
  FIREBLOCKS_API_SECRET: z
    .string()
    .min(1)
    .transform((key) => key.replace(/\\n/g, "\n").trim()),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  SAFE_PROXY_PROVIDER_TIMEOUT_MS: positiveInteger,
});

// On Cloud Run the caller is the service account its Google identity token names.
async function cloudRun() {
  const cloud = readEnv({
    PORT: positiveInteger,
    SAFE_PROXY_AUDIENCE: z.url({ protocol: /^https$/ }),
    SAFE_PROXY_API_CALLER: z.email(),
    SAFE_PROXY_CRON_CALLER: z.email(),
    // Above the age at which callers fetch a new token, so a token still being sent is never
    // refused.
    SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: positiveInteger
      .gt(IDENTITY_TOKEN_REFETCH_AFTER_SECONDS)
      .max(IDENTITY_TOKEN_LIFETIME_SECONDS),
  });
  // One account for both would give cron everything the API may do.
  if (cloud.SAFE_PROXY_API_CALLER === cloud.SAFE_PROXY_CRON_CALLER) {
    throw new Error("invalid settings: SAFE_PROXY_CRON_CALLER");
  }
  const keys = createGoogleIdentityKeys();
  // The port opens only once the identity keys have been fetched.
  await keys.reload();
  return {
    caller: googleCaller({
      audience: cloud.SAFE_PROXY_AUDIENCE,
      keys,
      maxTokenAgeSeconds: cloud.SAFE_PROXY_MAX_TOKEN_AGE_SECONDS,
      callerEmails: { api: cloud.SAFE_PROXY_API_CALLER, cron: cloud.SAFE_PROXY_CRON_CALLER },
    }),
    listensOn: { port: cloud.PORT },
  };
}

// Anywhere else this is the local proxy: it listens on loopback only and its callers name
// themselves.
function local() {
  const { SDP_SAFE_PROXY_PORT: port } = readEnv({ SDP_SAFE_PROXY_PORT: positiveInteger });
  const listensOn = { hostname: "127.0.0.1", port };
  return { caller: localCaller(listensOn), listensOn };
}

// The one place the runtime is chosen: Cloud Run sets K_SERVICE on every container.
const runtime = process.env.K_SERVICE === undefined ? local() : await cloudRun();

const app = createApp({
  caller: runtime.caller,
  credentials: {
    fireblocks: {
      apiKey: env.FIREBLOCKS_API_KEY,
      privateKey: await importPKCS8(env.FIREBLOCKS_API_SECRET, "RS256"),
    },
    privy: { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET },
  },
  providerTimeoutMs: env.SAFE_PROXY_PROVIDER_TIMEOUT_MS,
});

const server = serve({ fetch: app.fetch, ...runtime.listensOn });
process.on("SIGTERM", () => server.close());
