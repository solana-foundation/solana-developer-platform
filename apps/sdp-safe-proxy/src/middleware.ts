import { CallerIdentityError, createCallerIdentityVerifier } from "@sdp/metadata-server/receiver";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RequestIdVariables } from "hono/request-id";
import type { JWTVerifyGetKey } from "jose";
import { forbidden, payloadTooLarge, serviceUnavailable, unauthorized } from "./errors";

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
}

export type AppEnv = {
  Variables: RequestIdVariables & { line: RequestLogLine; caller: SafeProxyCaller };
};

const MAX_BODY_BYTES = 1024 * 1024;

// One log line per request, written once the answer is known. Runs after `requestId()`.
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const startedAt = Date.now();
  const line: RequestLogLine = {
    request_id: c.get("requestId"),
    caller: null,
    provider: null,
    endpoint: null,
    error: null,
    status: 0,
    duration_ms: 0,
  };
  c.set("line", line);
  await next();
  // Sent back on every answer, the provider's included, so both sides log the same id.
  c.header("X-Request-Id", line.request_id);
  line.status = c.res.status;
  line.duration_ms = Date.now() - startedAt;
  // One JSON object per line is what Cloud Logging reads as a structured entry.
  console.log(JSON.stringify(line));
};

export const bodyWithinLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw payloadTooLarge();
  },
});

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
