import {
  type CallerIdentity,
  CallerIdentityError,
  createCallerIdentityVerifier,
} from "@sdp/metadata-server/receiver";
import { scrubTelemetry } from "@sdp/redaction/scrub";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RequestIdVariables } from "hono/request-id";
import type { JWTVerifyGetKey } from "jose";
import pino from "pino";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "./endpoints/callers";
import { LOCAL_CALLER_HEADER } from "./endpoints/protocol";
import { forbidden, payloadTooLarge, serviceUnavailable, unauthorized } from "./errors";

export interface RequestLogLine {
  request_id: string;
  caller: SafeProxyCaller | null;
  provider: string | null;
  endpoint: string | null;
  error: string | null;
  status: number;
  duration_ms: number;
}

export type AppEnv = {
  Variables: RequestIdVariables & { line: RequestLogLine; caller: SafeProxyCaller };
};

const MAX_BODY_BYTES = 1024 * 1024;

const REQUEST_EVENT = "sdp_safe_proxy_request";

const SEVERITY = { info: "INFO", warn: "WARNING", error: "ERROR" } as const;

export const logger = pino({
  base: undefined,
  messageKey: "message",
  hooks: {
    logMethod(args, method) {
      // SAFETY: the scrubber returns each argument with its type unchanged.
      method.apply(this, args.map((argument) => scrubTelemetry(argument)) as typeof args);
    },
  },
});

function levelFor(status: number): keyof typeof SEVERITY {
  if (status >= 500) return "error";
  return status >= 400 ? "warn" : "info";
}

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
  c.header("X-Request-Id", line.request_id);
  line.status = c.res.status;
  line.duration_ms = Date.now() - startedAt;
  const level = levelFor(line.status);
  logger[level]({ event: REQUEST_EVENT, severity: SEVERITY[level], ...line }, REQUEST_EVENT);
};

export const bodyWithinLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw payloadTooLarge();
  },
});

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
    let identity: CallerIdentity;
    try {
      identity = await verify(c.req.header("authorization"));
    } catch (error) {
      if (!(error instanceof CallerIdentityError)) throw error;
      throw error.code === "keys_unavailable" ? serviceUnavailable() : unauthorized();
    }
    const caller = SAFE_PROXY_CALLERS.find((name) => options.callerEmails[name] === identity.email);
    if (caller === undefined) throw forbidden("caller_not_allowed");
    c.set("caller", caller);
    await next();
  };
}

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
