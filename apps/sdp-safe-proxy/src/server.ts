import { serve } from "@hono/node-server";
import { createGoogleIdentityKeys } from "@sdp/metadata-server/receiver";
import { importPKCS8 } from "jose";
import { createApp, googleCaller, localCaller } from "./app";

// A failure names the setting, never its value.
function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing setting: ${name}`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(setting(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid setting: ${name}`);
  return value;
}

// On Cloud Run the caller is the service account its Google identity token names.
async function cloudRun() {
  const keys = createGoogleIdentityKeys();
  // The port opens only once the identity keys have been fetched.
  await keys.reload();
  return {
    caller: googleCaller({
      audience: setting("SAFE_PROXY_AUDIENCE"),
      keys,
      maxTokenAgeSeconds: positiveInteger("SAFE_PROXY_MAX_TOKEN_AGE_SECONDS"),
      callerEmails: {
        api: setting("SAFE_PROXY_API_CALLER"),
        cron: setting("SAFE_PROXY_CRON_CALLER"),
      },
    }),
    listensOn: { port: positiveInteger("PORT") },
  };
}

// Anywhere else this is the local proxy: it listens on loopback only and its callers name
// themselves.
function local() {
  const listensOn = { hostname: "127.0.0.1", port: positiveInteger("SDP_SAFE_PROXY_PORT") };
  return { caller: localCaller(listensOn), listensOn };
}

// The one place the runtime is chosen: Cloud Run sets K_SERVICE on every container.
const runtime = process.env.K_SERVICE === undefined ? local() : await cloudRun();

const app = createApp({
  caller: runtime.caller,
  credentials: {
    fireblocks: {
      apiKey: setting("FIREBLOCKS_API_KEY"),
      // The key may arrive on one line with its line breaks written as `\n`.
      privateKey: await importPKCS8(
        setting("FIREBLOCKS_API_SECRET").replace(/\\n/g, "\n").trim(),
        "RS256"
      ),
    },
    privy: { appId: setting("PRIVY_APP_ID"), appSecret: setting("PRIVY_APP_SECRET") },
  },
  providerTimeoutMs: positiveInteger("SAFE_PROXY_PROVIDER_TIMEOUT_MS"),
});

const server = serve({ fetch: app.fetch, ...runtime.listensOn });
process.on("SIGTERM", () => server.close());
