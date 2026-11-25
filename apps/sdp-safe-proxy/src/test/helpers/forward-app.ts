import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { TestContext } from "node:test";
import type { SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { createLocalJWKSet, importPKCS8, type JWTVerifyGetKey, SignJWT } from "jose";
import { type AppDependencies, createApp, googleCaller, type ProviderCredentials } from "@/app";

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

// Takes over the platform's `fetch` and `console.log` until the test ends, so build one app per test.
export function createForwardApp(t: TestContext, options: ForwardAppOptions = {}) {
  const calls: ProviderCall[] = [];
  const logged: object[] = [];

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
  t.mock.method(console, "log", (text: unknown) => {
    assert.ok(typeof text === "string", "a log line is written as text");
    const line: unknown = JSON.parse(text);
    assert.ok(typeof line === "object" && line !== null && "duration_ms" in line, "a log line");
    // The duration is the one field a test cannot fix in advance.
    const { duration_ms, ...rest } = line;
    assert.equal(typeof duration_ms, "number");
    logged.push(rest);
  });

  const app = createApp({
    caller:
      options.caller ??
      googleCaller({
        audience: AUDIENCE,
        keys: options.keys ?? trustedKeys,
        maxTokenAgeSeconds: 300,
        callerEmails: CALLER_EMAILS,
      }),
    credentials: options.credentials ?? PLATFORM_CREDENTIALS,
    providerTimeoutMs: 10_000,
  });

  async function send(path: string, request: ForwardRequest = {}): Promise<Response> {
    const headers = new Headers({ "x-request-id": "req-7d1", ...request.headers });
    const token = request.token === undefined ? "api" : request.token;
    if (token !== null) headers.set("authorization", `Bearer ${await identityToken(token)}`);
    return app.request(path, { method: request.method ?? "GET", headers, body: request.body });
  }

  // `calls` holds every provider call as sent, `logged` every request log line written to stdout.
  return { calls, logged, send };
}
