import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { REQUEST_ID_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { createCallerIdentityVerifier } from "@sdp/service-call/caller-identity";
import { createLocalJWKSet, importPKCS8, type JWTVerifyGetKey, SignJWT } from "jose";
import {
  createApp,
  createTokenCallerCheck,
  type ProviderCredentials,
  type RequestLogLine,
} from "@/app";

const AUDIENCE = "https://safe-proxy.mock.invalid";
const NOW_MS = 1_800_000_000_000;
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

export interface ForwardRequest {
  method?: string;
  // The identity token sent: one a caller's service account holds, one for a service account no
  // caller has, one signed by a key Google never published, or none.
  token?: SafeProxyCaller | "stranger" | "forged" | null;
  headers?: Record<string, string>;
  body?: string;
}

export interface ForwardAppOptions {
  answer?: (call: ProviderCall) => Response | Promise<Response>;
  keys?: JWTVerifyGetKey;
  credentials?: ProviderCredentials;
}

async function identityToken(token: SafeProxyCaller | "stranger" | "forged"): Promise<string> {
  const email =
    token === "stranger"
      ? "stranger@callers.mock.invalid"
      : CALLER_EMAILS[token === "forged" ? "api" : token];
  const issuedAt = NOW_MS / 1000 - 42;
  return new SignJWT({ email, email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(token === "forged" ? forgedKeys.privateKey : callerKeys.privateKey);
}

export function createForwardApp(options: ForwardAppOptions = {}) {
  const calls: ProviderCall[] = [];
  const logged: RequestLogLine[] = [];

  const app = createApp({
    identifyCaller: createTokenCallerCheck({
      verify: createCallerIdentityVerifier({
        audience: AUDIENCE,
        keys: options.keys ?? trustedKeys,
        maxTokenAgeSeconds: 300,
        now: () => NOW_MS,
      }),
      callerEmails: CALLER_EMAILS,
    }),
    credentials: options.credentials ?? PLATFORM_CREDENTIALS,
    fetch: async (input, init) => {
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
    },
    providerTimeoutMs: 10_000,
    writeLog: (line) => logged.push(line),
    revision: "sdp-safe-proxy-00042-abc",
  });

  async function send(path: string, request: ForwardRequest = {}): Promise<Response> {
    const headers = new Headers({ [REQUEST_ID_HEADER]: "req-7d1", ...request.headers });
    const token = request.token === undefined ? "api" : request.token;
    if (token !== null) headers.set("authorization", `Bearer ${await identityToken(token)}`);
    return app.request(path, { method: request.method ?? "GET", headers, body: request.body });
  }

  // `calls` holds every provider call as sent, `logged` every request log line as written.
  return { calls, logged, send };
}
