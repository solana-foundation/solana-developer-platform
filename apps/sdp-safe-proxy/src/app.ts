import { createHash, randomUUID } from "node:crypto";
import { type CallerIdentity, CallerIdentityError } from "@sdp/metadata-server/receiver";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { matchEndpoint } from "@sdp/safe-proxy-endpoints/match";
import {
  FROM_PROVIDER_HEADER,
  LOCAL_CALLER_HEADER,
  REQUEST_ID_HEADER,
} from "@sdp/safe-proxy-endpoints/protocol";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { badGateway, forbidden, notFound, serviceUnavailable, unauthorized } from "./errors";

type IdentifyCaller = (headers: Headers) => Promise<SafeProxyCaller>;

export interface ProviderCredentials {
  fireblocks: { apiKey: string; privateKey: CryptoKey };
  privy: { appId: string; appSecret: string };
}

export interface AppDependencies {
  identifyCaller: IdentifyCaller;
  credentials: ProviderCredentials;
  fetch: typeof fetch;
  providerTimeoutMs: number;
  writeLog: (line: RequestLogLine) => void;
  revision: string;
}

export interface RequestLogLine {
  request_id: string | null;
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

type AppEnv = { Variables: { line: RequestLogLine } };

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) =>
    c.json({ service: "sdp-safe-proxy", revision: dependencies.revision })
  );

  // One log line per request, written once the answer is known.
  app.use(async (c, next) => {
    const startedAt = Date.now();
    const requestId = c.req.header(REQUEST_ID_HEADER);
    const line: RequestLogLine = {
      // Logged only in the shape callers send it; anything else is left out.
      request_id: requestId !== undefined && REQUEST_ID.test(requestId) ? requestId : null,
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
    line.status = c.res.status;
    line.duration_ms = Date.now() - startedAt;
    dependencies.writeLog(line);
  });

  // METHOD /<provider>/<the provider's own path and query>
  app.all("/:provider/*", bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
    const line = c.get("line");
    const caller = await dependencies.identifyCaller(c.req.raw.headers);
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

    // The provider's answer goes back as it came: its status, its body, its content type. The
    // marker is the only header the proxy adds.
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

// On Cloud Run: the caller is the service account its Google identity token names.
export function createTokenCallerCheck(options: {
  verify: (authorizationHeader: string | undefined) => Promise<CallerIdentity>;
  callerEmails: Record<SafeProxyCaller, string>;
}): IdentifyCaller {
  return async (headers) => {
    let identity: CallerIdentity;
    try {
      identity = await options.verify(headers.get("authorization") ?? undefined);
    } catch (error) {
      if (!(error instanceof CallerIdentityError)) throw error;
      throw error.code === "keys_unavailable" ? serviceUnavailable() : unauthorized();
    }
    const caller = SAFE_PROXY_CALLERS.find((name) => options.callerEmails[name] === identity.email);
    if (caller === undefined) throw forbidden("caller_not_allowed");
    return caller;
  };
}

// Locally: the caller addresses the loopback address and port the proxy listens on, and names
// itself.
export function createLocalCallerCheck(listensOn: {
  hostname: string;
  port: number;
}): IdentifyCaller {
  const host = `${listensOn.hostname}:${listensOn.port}`;
  return async (headers) => {
    const named = headers.get(LOCAL_CALLER_HEADER);
    const caller = SAFE_PROXY_CALLERS.find((name) => name === named);
    if (headers.get("host") !== host || caller === undefined) throw unauthorized();
    return caller;
  };
}

type FireblocksAuthHeaders = { Authorization: string; "X-API-Key": string };
type PrivyAuthHeaders = { Authorization: string; "privy-app-id": string };

const FIREBLOCKS_TOKEN_LIFETIME_SECONDS = 30;

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
      const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ bodyHash, nonce: randomUUID(), uri: target })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject(apiKey)
        .setIssuedAt(now)
        .setExpirationTime(now + FIREBLOCKS_TOKEN_LIFETIME_SECONDS)
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
