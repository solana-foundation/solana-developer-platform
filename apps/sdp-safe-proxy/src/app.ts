import { createHash, randomUUID } from "node:crypto";
import { CallerIdentityError, createCallerIdentityVerifier } from "@sdp/metadata-server/receiver";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { matchEndpoint } from "@sdp/safe-proxy-endpoints/match";
import { FROM_PROVIDER_HEADER, LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type RequestIdVariables, requestId } from "hono/request-id";
import { type JWTVerifyGetKey, SignJWT } from "jose";
import {
  badGateway,
  forbidden,
  notFound,
  payloadTooLarge,
  serviceUnavailable,
  unauthorized,
} from "./errors";

export interface ProviderCredentials {
  fireblocks: { apiKey: string; privateKey: CryptoKey };
  privy: { appId: string; appSecret: string };
}

export interface AppDependencies {
  // `googleCaller` on Cloud Run, `localCaller` anywhere else.
  caller: MiddlewareHandler<AppEnv>;
  credentials: ProviderCredentials;
  fetch: typeof fetch;
  providerTimeoutMs: number;
  writeLog: (line: RequestLogLine) => void;
  revision: string;
}

export interface RequestLogLine {
  request_id: string;
  caller: SafeProxyCaller | null;
  provider: string | null;
  // The declared method and path pattern, never the path that was requested.
  endpoint: string | null;
  // Set when the answer is the proxy's own and not the provider's.
  error: string | null;
  status: number;
  duration_ms: number;
  revision: string;
}

type AppEnv = {
  Variables: RequestIdVariables & { line: RequestLogLine; caller: SafeProxyCaller };
};

const MAX_BODY_BYTES = 1024 * 1024;

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) =>
    c.json({ service: "sdp-safe-proxy", revision: dependencies.revision })
  );

  // The caller's `X-Request-Id`, or a new one when it sent none.
  app.use(requestId());

  // One log line per request, written once the answer is known.
  app.use(async (c, next) => {
    const startedAt = Date.now();
    const line: RequestLogLine = {
      request_id: c.get("requestId"),
      caller: null,
      provider: null,
      endpoint: null,
      error: null,
      status: 0,
      duration_ms: 0,
      revision: dependencies.revision,
    };
    c.set("line", line);
    await next();
    // Sent back on every answer, the provider's included, so both sides log the same id.
    c.header("X-Request-Id", line.request_id);
    line.status = c.res.status;
    line.duration_ms = Date.now() - startedAt;
    dependencies.writeLog(line);
  });

  // METHOD /<provider>/<the provider's own path and query>
  const bodyWithinLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw payloadTooLarge();
    },
  });

  app.all("/:provider/*", bodyWithinLimit, dependencies.caller, async (c) => {
    const line = c.get("line");
    const caller = c.get("caller");
    line.caller = caller;

    const { pathname, search } = new URL(c.req.url);
    const providerEnd = pathname.indexOf("/", 1);
    if (providerEnd === -1) throw notFound();
    const target = pathname.slice(providerEnd) + search;
    const body = await c.req.text();

    const match = matchEndpoint({
      provider: pathname.slice(1, providerEnd),
      method: c.req.method,
      path: target,
      body,
    });
    if (!match.allowed) throw forbidden(match.code);
    const { provider, endpoint } = match;
    line.provider = provider;
    line.endpoint = `${endpoint.method} ${endpoint.path}`;

    if (!endpoint.callers.includes(caller)) throw forbidden("caller_not_allowed");

    // Only the headers the endpoint declares are passed through; the auth is set last.
    const headers = new Headers();
    for (const name of endpoint.requestHeaders) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    if (body !== "") headers.set("content-type", "application/json");
    const auth = await authHeaders(provider, dependencies.credentials, target, body);
    for (const [name, value] of Object.entries(auth)) headers.set(name, value);

    let answer: Response;
    try {
      answer = await dependencies.fetch(
        `https://${SAFE_PROXY_PROVIDERS[provider].hosts[0]}${target}`,
        {
          method: endpoint.method,
          headers,
          body: body === "" ? null : body,
          redirect: "manual",
          signal: AbortSignal.timeout(dependencies.providerTimeoutMs),
        }
      );
    } catch {
      throw badGateway();
    }

    // The provider's answer goes back as it came: its status, its body, its content type.
    const answerHeaders = new Headers({ [FROM_PROVIDER_HEADER]: "1" });
    const contentType = answer.headers.get("content-type");
    if (contentType !== null) answerHeaders.set("content-type", contentType);
    return new Response(answer.body, { status: answer.status, headers: answerHeaders });
  });

  // Returned, not thrown: an error thrown here would skip the request log.
  app.notFound((c) => {
    const error = notFound();
    c.get("line").error = error.message;
    return error.getResponse();
  });

  app.onError((error, c) => {
    c.get("line").error = error instanceof HTTPException ? error.message : error.constructor.name;
    return error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "internal" }, 500);
  });

  return app;
}

// On Cloud Run: the caller is the service account its Google identity token names. The token is
// verified here as well as by Cloud Run.
export function googleCaller(options: {
  audience: string;
  keys: JWTVerifyGetKey;
  maxTokenAgeSeconds: number;
  callerEmails: Record<SafeProxyCaller, string>;
}): MiddlewareHandler<AppEnv> {
  const verify = createCallerIdentityVerifier({
    audience: options.audience,
    keys: options.keys,
    maxTokenAgeSeconds: options.maxTokenAgeSeconds,
    now: Date.now,
  });
  return async (c, next) => {
    const identity = await verify(c.req.header("authorization")).catch((error: unknown) => {
      if (!(error instanceof CallerIdentityError)) throw error;
      throw error.code === "keys_unavailable" ? serviceUnavailable() : unauthorized();
    });
    const caller = SAFE_PROXY_CALLERS.find((name) => options.callerEmails[name] === identity.email);
    if (caller === undefined) throw forbidden("caller_not_allowed");
    c.set("caller", caller);
    await next();
  };
}

// Locally: the caller addresses the loopback address and port the proxy listens on, and names
// itself.
export function localCaller(listensOn: {
  hostname: string;
  port: number;
}): MiddlewareHandler<AppEnv> {
  const host = `${listensOn.hostname}:${listensOn.port}`;
  return async (c, next) => {
    const named = c.req.header(LOCAL_CALLER_HEADER);
    const caller = SAFE_PROXY_CALLERS.find((name) => name === named);
    if (c.req.header("host") !== host || caller === undefined) throw unauthorized();
    c.set("caller", caller);
    await next();
  };
}

type FireblocksAuthHeaders = { Authorization: string; "X-API-Key": string };
type PrivyAuthHeaders = { Authorization: string; "privy-app-id": string };

// `target` and `body` are the request exactly as it is sent: the Fireblocks token covers both.
async function authHeaders(
  provider: SafeProxyProvider,
  credentials: ProviderCredentials,
  target: string,
  body: string
): Promise<FireblocksAuthHeaders | PrivyAuthHeaders> {
  switch (provider) {
    case "fireblocks": {
      const { apiKey, privateKey } = credentials.fireblocks;
      const tokenLifetimeSeconds = 30;
      const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ bodyHash, nonce: randomUUID(), uri: target })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject(apiKey)
        .setIssuedAt(now)
        .setExpirationTime(now + tokenLifetimeSeconds)
        .sign(privateKey);
      return { Authorization: `Bearer ${token}`, "X-API-Key": apiKey };
    }
    case "privy": {
      const { appId, appSecret } = credentials.privy;
      const basic = Buffer.from(`${appId}:${appSecret}`, "utf8").toString("base64");
      return { Authorization: `Basic ${basic}`, "privy-app-id": appId };
    }
    default: {
      const unreachable: never = provider;
      return unreachable;
    }
  }
}
