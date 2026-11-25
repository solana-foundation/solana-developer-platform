import { serve } from "@hono/node-server";
import { IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "@sdp/metadata-server/caller";
import { createGoogleIdentityKeys } from "@sdp/metadata-server/receiver";
import {
  isCustodyProviderInReleaseChannel,
  SDP_RELEASE_CHANNEL_NAMES,
} from "@sdp/types/release-channels";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { createApp } from "./app";
import type { SafeProxyProvider } from "./endpoints/providers";
import { googleCaller, localCaller } from "./middleware";
import { positiveInteger, readEnv } from "./utils";

const IDENTITY_TOKEN_LIFETIME_SECONDS = 3600;

const env = readEnv({
  SDP_RELEASE_CHANNEL: z.enum(SDP_RELEASE_CHANNEL_NAMES),
  SAFE_PROXY_PROVIDER_TIMEOUT_MS: positiveInteger,
});

function inReleaseChannel(provider: SafeProxyProvider): boolean {
  return isCustodyProviderInReleaseChannel(env.SDP_RELEASE_CHANNEL, provider, "managed");
}

async function fireblocksCredentials() {
  const fireblocks = readEnv({
    FIREBLOCKS_API_KEY: z.string().min(1),
    FIREBLOCKS_API_SECRET: z
      .string()
      .min(1)
      .transform((key) => key.replace(/\\n/g, "\n").trim()),
  });
  return {
    apiKey: fireblocks.FIREBLOCKS_API_KEY,
    privateKey: await importPKCS8(fireblocks.FIREBLOCKS_API_SECRET, "RS256"),
  };
}

function privyCredentials() {
  const privy = readEnv({ PRIVY_APP_ID: z.string().min(1), PRIVY_APP_SECRET: z.string().min(1) });
  return { appId: privy.PRIVY_APP_ID, appSecret: privy.PRIVY_APP_SECRET };
}

async function cloudRun() {
  const cloud = readEnv({
    PORT: positiveInteger,
    SAFE_PROXY_AUDIENCE: z.url({ protocol: /^https$/ }),
    SAFE_PROXY_API_CALLER: z.email(),
    SAFE_PROXY_CRON_CALLER: z.email(),
    SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: positiveInteger
      .gt(IDENTITY_TOKEN_REFETCH_AFTER_SECONDS)
      .max(IDENTITY_TOKEN_LIFETIME_SECONDS),
  });
  if (cloud.SAFE_PROXY_API_CALLER === cloud.SAFE_PROXY_CRON_CALLER) {
    throw new Error("invalid settings: SAFE_PROXY_CRON_CALLER");
  }
  const keys = createGoogleIdentityKeys();
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

function local() {
  const { SDP_SAFE_PROXY_PORT: port } = readEnv({ SDP_SAFE_PROXY_PORT: positiveInteger });
  const listensOn = { hostname: "127.0.0.1", port };
  return { caller: localCaller(listensOn), listensOn };
}

const runtime = process.env.K_SERVICE === undefined ? local() : await cloudRun();

const app = createApp({
  caller: runtime.caller,
  releaseChannel: env.SDP_RELEASE_CHANNEL,
  credentials: {
    fireblocks: inReleaseChannel("fireblocks") ? await fireblocksCredentials() : null,
    privy: inReleaseChannel("privy") ? privyCredentials() : null,
  },
  providerTimeoutMs: env.SAFE_PROXY_PROVIDER_TIMEOUT_MS,
});

const server = serve({ fetch: app.fetch, ...runtime.listensOn });
process.on("SIGTERM", () => server.close());
