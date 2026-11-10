import { AsyncLocalStorage } from "node:async_hooks";
import { scrubTelemetry, scrubTelemetryString } from "@sdp/redaction/scrub";
import { activeClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import pino, { type Logger, type LoggerOptions } from "pino";
import { currentDatabaseIdentity } from "@/db/identity";
import { currentMoneyPrincipal } from "@/lib/money-principal";
import { LOG_REDACTION_PATHS, REDACTION_CENSOR } from "./log-redaction";

export interface LogContext {
  request_id?: string;
  trace_id?: string;
  web_trace_hash?: string;
  /** The request's HTTP method and matched route pattern, never its concrete path. */
  route?: string;
  /** The Cron Definition whose slot is running. */
  cron?: string;
}

const store = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = store.getStore();
  return store.run({ ...parent, ...context }, fn);
}

export function getLogContext(): LogContext {
  return store.getStore() ?? {};
}

/**
 * Who the work runs as, read from the scopes authentication already opened: the tenant database
 * identity, the money principal and the cluster scope. Each ends with the middleware that opened
 * it, so a line written after it returns (the request's timing line) carries none of this.
 */
interface AmbientIdentity {
  organization_id?: string;
  project_id?: string;
  environment?: SdpEnvironment;
  api_key_id?: string;
  user_id?: string;
}

function ambientIdentity(): AmbientIdentity {
  const identity: AmbientIdentity = {};
  const database = currentDatabaseIdentity();
  if (database?.kind === "tenant") identity.organization_id = database.organizationId;
  const cluster = activeClusterScope();
  if (cluster) {
    identity.environment = cluster.environment;
    if (cluster.projectId) identity.project_id = cluster.projectId;
  }
  const principal = currentMoneyPrincipal();
  if (principal?.kind === "api_key") identity.api_key_id = principal.apiKeyId;
  if (principal?.kind === "member") identity.user_id = principal.userId;
  return identity;
}

function serializeError(value: unknown): unknown {
  return value instanceof Error
    ? {
        type: value.name,
        message: scrubTelemetryString(value.message),
        stack: value.stack ? scrubTelemetryString(value.stack) : value.stack,
      }
    : value;
}

const CLOUD_SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export function baseLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    messageKey: "message",
    formatters: {
      level(label, number) {
        return { level: number, severity: CLOUD_SEVERITY[label] ?? "DEFAULT" };
      },
    },
    serializers: { error: serializeError, err: serializeError },
    // Two redaction mechanisms, deliberately. They cover different things and
    // neither subsumes the other:
    //
    // - `hooks.logMethod` runs the shared denylist (`@sdp/redaction`) over every
    //   argument, at any depth. It matches by key *name*, so it needs no path
    //   registration, but it only knows the names it knows.
    // - `redact` censors the registered paths in `./log-redaction`, whose keys
    //   (`viewingKey`, `nullifierKey`, `ringsMetadata`, `proof.*`) are NOT in the
    //   shared denylist — they are Helius Rings key material, not credentials or
    //   counterparty PII. It matches by path, so it reaches one nesting level.
    //
    // Order: the hook rewrites the arguments before pino processes them, so
    // `redact` censors paths on the already-scrubbed copy. Structure is
    // preserved by the scrubber, so the registered paths still resolve.
    //
    // The scrubbing boundary is here rather than asked of call sites: a denylist
    // that depends on each caller remembering to wrap its payload is a denylist
    // that holds until the next handler is written. Everything a caller passes —
    // merged object, message, interpolation arguments — goes through it. The
    // `mixin` context bypasses hooks but only holds generated ids, a hash of a
    // strictly validated, server-generated web id, the HTTP method with the
    // registered route pattern, a Cron Definition name, and the ids and
    // environment `ambientIdentity` reads. A field the line passes itself wins.
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((argument) => scrubTelemetry(argument)) as typeof args);
      },
    },
    redact: { paths: [...LOG_REDACTION_PATHS], censor: REDACTION_CENSOR },
    mixin: () => ({ ...ambientIdentity(), ...getLogContext() }),
    ...(process.env.LOG_FORMAT === "pretty" ? { transport: { target: "pino-pretty" } } : {}),
  };
}

export const rootLogger: Logger = pino(baseLoggerOptions());

export function getLogger(): Logger {
  return rootLogger;
}
