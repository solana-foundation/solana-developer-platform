import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { createCallerIdentityVerifier } from "@sdp/service-call/caller-identity";
import { createLocalJWKSet, type JWTVerifyGetKey, SignJWT } from "jose";
import { createApp, type Readiness } from "@/app";
import { createTokenCallerCheck } from "@/caller";
import { createPlatformCredentialLoader, type ProviderCredentials } from "@/credentials";
import { createRequestLog } from "@/request-log";

const AUDIENCE = "https://safe-proxy.mock.invalid";
const ISSUER = "https://accounts.google.com";
const START_MS = 1_800_000_000_000;

export const CALLER_EMAILS = {
  api: "api@callers.mock.invalid",
  cron: "cron@callers.mock.invalid",
} as const satisfies Record<SafeProxyCaller, string>;
export const MAX_BUDGET_MS = 10_000;
export const MAX_TOKEN_AGE_S = 300;
export const REVISION = "sdp-safe-proxy-00042-abc";

const callerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const untrustedCallerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fireblocksKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const FIREBLOCKS_PUBLIC_PEM = fireblocksKeys.publicKey;
export const PLATFORM_CREDENTIALS = {
  privy: { appId: "privy-app-a31", appSecret: "privy-secret-q8z" },
  fireblocks: { apiKey: "fireblocks-key-k4w", apiSecretPem: fireblocksKeys.privateKey },
} as const satisfies ProviderCredentials;

// The request headers a well-formed forward carries; a test overrides one, or drops it with null.
export const FORWARD_REQUEST_HEADERS = {
  "sdp-safe-proxy-request-id": "req-7d1",
  "sdp-safe-proxy-budget-ms": "10000",
  "sdp-safe-proxy-credential": "platform",
} as const;

export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

export interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
}

export interface CallerTokenOptions {
  email?: string;
  ageSeconds?: number;
  untrusted?: true;
}

export interface ForwardRequest {
  method?: string;
  // The caller whose token is sent; null sends no authorization header.
  caller?: SafeProxyCaller | null;
  token?: CallerTokenOptions;
  authorization?: string;
  headers?: Record<string, string | null>;
  body?: string;
}

export interface ForwardAppOptions {
  answer?: (call: ProviderCall, clock: Clock) => Response | Promise<Response>;
  keys?: (trusted: JWTVerifyGetKey, clock: Clock) => JWTVerifyGetKey;
  credentials?: ProviderCredentials;
}

export function createForwardApp(options: ForwardAppOptions = {}) {
  let nowMs = START_MS;
  const clock: Clock = {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
  let readiness: Readiness = "starting";
  const calls: ProviderCall[] = [];
  const logged: string[] = [];

  const trustedKeys = createLocalJWKSet({
    keys: [{ ...callerKeys.publicKey.export({ format: "jwk" }), alg: "RS256" }],
  });
  const answer =
    options.answer ??
    (() =>
      new Response('{"id":"wallet-1"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

  const app = createApp({
    identifyCaller: createTokenCallerCheck({
      verify: createCallerIdentityVerifier({
        audience: AUDIENCE,
        keys: options.keys?.(trustedKeys, clock) ?? trustedKeys,
        maxTokenAgeSeconds: MAX_TOKEN_AGE_S,
        now: clock.now,
      }),
      callerEmails: CALLER_EMAILS,
      now: clock.now,
    }),
    loadCredential: createPlatformCredentialLoader(options.credentials ?? PLATFORM_CREDENTIALS),
    fetch: async (input, init) => {
      const call: ProviderCall = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body == null ? null : String(init.body),
        signal: init?.signal ?? null,
      };
      calls.push(call);
      return answer(call, clock);
    },
    now: clock.now,
    maxBudgetMs: MAX_BUDGET_MS,
    writeRequestLog: createRequestLog({ write: (line: string) => logged.push(line) }),
    readiness: () => readiness,
    revision: REVISION,
  });

  function callerToken(token: CallerTokenOptions = {}): Promise<string> {
    const issuedAt = Math.floor(nowMs / 1000) - (token.ageSeconds ?? 42);
    const key: KeyObject = token.untrusted ? untrustedCallerKeys.privateKey : callerKeys.privateKey;
    return new SignJWT({ email: token.email ?? CALLER_EMAILS.api, email_verified: true })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);
  }

  async function send(path: string, request: ForwardRequest = {}): Promise<Response> {
    const headers = new Headers();
    const caller = request.caller === undefined ? "api" : request.caller;
    if (request.authorization !== undefined) {
      headers.set("authorization", request.authorization);
    } else if (caller !== null) {
      const token = await callerToken({ email: CALLER_EMAILS[caller], ...request.token });
      headers.set("authorization", `Bearer ${token}`);
    }
    for (const [name, value] of Object.entries({
      ...FORWARD_REQUEST_HEADERS,
      ...request.headers,
    })) {
      if (value !== null) headers.set(name, value);
    }
    return app.request(path, { method: request.method ?? "GET", headers, body: request.body });
  }

  return {
    app,
    calls,
    clock,
    send,
    callerToken,
    setReadiness: (next: Readiness) => {
      readiness = next;
    },
    rawLogLines: (): readonly string[] => logged,
    // Each line as written, without pino's wall-clock `time`.
    logLines: (): Record<string, unknown>[] =>
      logged.map((line) => {
        const { time: _time, ...fields } = JSON.parse(line);
        return fields;
      }),
  };
}

export type ForwardApp = ReturnType<typeof createForwardApp>;
