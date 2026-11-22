import { generateKeyPairSync } from "node:crypto";
import type { SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { createCallerIdentityVerifier } from "@sdp/service-call/caller-identity";
import { createLocalJWKSet, type JWTVerifyGetKey, SignJWT } from "jose";
import { createApp } from "@/app";
import { createTokenCallerCheck } from "@/caller";
import { createPlatformCredentialLoader } from "@/credentials";
import type { ProviderCredentials } from "@/providers/auth-services";
import { createRequestLog } from "@/request-log";

const AUDIENCE = "https://safe-proxy.mock.invalid";
const NOW_MS = 1_800_000_000_000;
const CALLER_EMAILS = {
  api: "api@callers.mock.invalid",
  cron: "cron@callers.mock.invalid",
} as const satisfies Record<SafeProxyCaller, string>;

const callerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const untrustedCallerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const trustedKeys = createLocalJWKSet({
  keys: [{ ...callerKeys.publicKey.export({ format: "jwk" }), alg: "RS256" }],
});

export const PLATFORM_CREDENTIALS = {
  privy: { appId: "privy-app-a31", appSecret: "privy-secret-q8z" },
  fireblocks: {
    apiKey: "fireblocks-key-k4w",
    apiSecretPem: generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  },
} as const satisfies ProviderCredentials;

export interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null;
}

export interface ForwardRequest {
  method?: string;
  // The caller whose token is sent; null sends no authorization header.
  caller?: SafeProxyCaller | null;
  untrustedToken?: true;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
}

export interface ForwardAppOptions {
  answer?: (call: ProviderCall) => Response | Promise<Response>;
  keys?: (trusted: JWTVerifyGetKey) => JWTVerifyGetKey;
  credentials?: ProviderCredentials;
}

export function createForwardApp(options: ForwardAppOptions = {}) {
  const calls: ProviderCall[] = [];
  const logged: string[] = [];
  const tokens: string[] = [];

  const app = createApp({
    identifyCaller: createTokenCallerCheck({
      verify: createCallerIdentityVerifier({
        audience: AUDIENCE,
        keys: options.keys?.(trustedKeys) ?? trustedKeys,
        maxTokenAgeSeconds: 300,
        now: () => NOW_MS,
      }),
      callerEmails: CALLER_EMAILS,
      now: () => NOW_MS,
    }),
    loadCredential: createPlatformCredentialLoader(options.credentials ?? PLATFORM_CREDENTIALS),
    fetch: async (input, init) => {
      const call: ProviderCall = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body == null ? null : String(init.body),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
      };
      calls.push(call);
      return (options.answer ?? (() => new Response('{"id":"wallet-1"}')))(call);
    },
    now: () => NOW_MS,
    maxBudgetMs: 10_000,
    writeRequestLog: createRequestLog({ write: (line: string) => logged.push(line) }),
    readiness: () => "ready",
    revision: "sdp-safe-proxy-00042-abc",
  });

  async function send(path: string, request: ForwardRequest = {}): Promise<Response> {
    const headers = new Headers({
      "sdp-safe-proxy-request-id": "req-7d1",
      "sdp-safe-proxy-budget-ms": "10000",
      "sdp-safe-proxy-credential": "platform",
      ...request.headers,
    });
    const caller = request.caller === undefined ? "api" : request.caller;
    if (caller !== null) {
      const issuedAt = NOW_MS / 1000 - 42;
      const token = await new SignJWT({ email: CALLER_EMAILS[caller], email_verified: true })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://accounts.google.com")
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 3600)
        .sign(request.untrustedToken ? untrustedCallerKeys.privateKey : callerKeys.privateKey);
      tokens.push(token);
      headers.set("authorization", `Bearer ${token}`);
    }
    return app.request(path, {
      method: request.method ?? "GET",
      headers,
      body: request.body,
      duplex: "half",
    });
  }

  // `tokens` holds every caller token sent, `logged` every request log line as written.
  return { calls, send, tokens, logged };
}
