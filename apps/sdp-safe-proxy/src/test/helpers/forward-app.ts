import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { TestContext } from "node:test";
import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { createLocalJWKSet, importPKCS8, type JWTVerifyGetKey, SignJWT } from "jose";
import { z } from "zod";
import { type AppDependencies, createApp, type ProviderCredentials } from "@/app";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@/endpoints/callers";
import { logger, type RequestLogLine } from "@/logger";
import { googleCaller } from "@/middleware";
import { EVERY_PROVIDER_CHANNEL } from "./release-channels";

const AUDIENCE = "https://safe-proxy.mock.invalid";
const CALLER_EMAILS = {
  api: "api@callers.mock.invalid",
  cron: "cron@callers.mock.invalid",
} as const satisfies Record<SafeProxyCaller, string>;

const callerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const forgedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const trustedKeys = createLocalJWKSet({
  keys: [{ ...callerKeys.publicKey.export({ format: "jwk" }), alg: "RS256" }],
});

const fireblocksKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
export const FIREBLOCKS_PUBLIC_KEY_PEM = fireblocksKeys.publicKey;

export const PLATFORM_CREDENTIALS = {
  privy: { appId: "app_7k2", appSecret: "sécret" },
  fireblocks: {
    apiKey: "fireblocks-key-k4w",
    privateKey: await importPKCS8(fireblocksKeys.privateKey, "RS256"),
  },
} as const satisfies ProviderCredentials;

export interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestInit["redirect"];
}

// Strict, so a key the written line gains fails the parse; typed against the line, so a field the
// type gains fails the typecheck.
const LogLine = z.strictObject({
  event: z.string(),
  severity: z.string(),
  request_id: z.string(),
  caller: z.enum(SAFE_PROXY_CALLERS).nullable(),
  provider: z.string().nullable(),
  endpoint: z.string().nullable(),
  error: z.string().nullable(),
  status: z.number(),
  duration_ms: z.number(),
}) satisfies z.ZodType<RequestLogLine>;

// The logger methods a request line can be written at.
const LOG_LEVELS = ["info", "warn", "error"] as const;

export type LoggedLine = Omit<z.infer<typeof LogLine>, "duration_ms"> & {
  level: (typeof LOG_LEVELS)[number];
  message: string;
};

type IdentityToken = SafeProxyCaller | "stranger" | "forged";

// The email each identity token names: a forged token names a real caller.
const TOKEN_EMAILS = {
  ...CALLER_EMAILS,
  stranger: "stranger@callers.mock.invalid",
  forged: CALLER_EMAILS.api,
} as const satisfies Record<IdentityToken, string>;

export interface ForwardRequest {
  method?: string;
  // The identity token sent: one a caller's service account holds, one for a service account no
  // caller has, one signed by a key Google never published, or none.
  token?: IdentityToken | null;
  headers?: Record<string, string>;
  body?: string;
}

export interface ForwardAppOptions {
  answer?: (call: ProviderCall) => Response | Promise<Response>;
  caller?: AppDependencies["caller"];
  keys?: JWTVerifyGetKey;
  releaseChannel?: SdpReleaseChannel;
  credentials?: ProviderCredentials;
}

// Issued against the clock the proxy reads, real or mocked.
async function identityToken(token: IdentityToken): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000) - 42;
  return new SignJWT({ email: TOKEN_EMAILS[token], email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(token === "forged" ? forgedKeys.privateKey : callerKeys.privateKey);
}

// Takes over the platform's `fetch` and the proxy's logger until the test ends, so build one app
// per test.
export function createForwardApp(t: TestContext, options: ForwardAppOptions = {}) {
  const calls: ProviderCall[] = [];
  const logged: LoggedLine[] = [];

  const provider: typeof fetch = async (input, init) => {
    assert.ok(init, "the provider call carries its options");
    const call: ProviderCall = {
      url: String(input),
      method: String(init.method),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body == null ? null : String(init.body),
      redirect: init.redirect,
    };
    calls.push(call);
    return (options.answer ?? (() => new Response('{"id":"wallet-1"}')))(call);
  };
  t.mock.method(globalThis, "fetch", provider);
  for (const level of LOG_LEVELS) {
    t.mock.method(logger, level, (fields: z.infer<typeof LogLine>, message: string) => {
      // The duration is the one field a test cannot fix in advance: the schema holds it to a number.
      const { duration_ms, ...line } = LogLine.parse(fields);
      logged.push({ level, message, ...line });
    });
  }

  const app = createApp({
    caller:
      options.caller ??
      googleCaller({
        audience: AUDIENCE,
        keys: options.keys ?? trustedKeys,
        maxTokenAgeSeconds: 300,
        callerEmails: CALLER_EMAILS,
      }),
    releaseChannel: options.releaseChannel ?? EVERY_PROVIDER_CHANNEL,
    credentials: options.credentials ?? PLATFORM_CREDENTIALS,
    providerTimeoutMs: 10_000,
  });

  async function send(path: string, request: ForwardRequest = {}): Promise<Response> {
    const headers = new Headers({ "x-request-id": "req-7d1", ...request.headers });
    const token = request.token === undefined ? "api" : request.token;
    if (token !== null) headers.set("authorization", `Bearer ${await identityToken(token)}`);
    return app.request(path, { method: request.method ?? "GET", headers, body: request.body });
  }

  // `calls` holds every provider call as sent, `logged` every line handed to the logger.
  return { calls, logged, send };
}
