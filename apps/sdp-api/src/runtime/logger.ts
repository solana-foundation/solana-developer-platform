import { AsyncLocalStorage } from "node:async_hooks";
import { scrubTelemetry, scrubTelemetryString } from "@sdp/redaction";
import pino, { type Logger, type LoggerOptions } from "pino";
import { LOG_REDACTION_PATHS, REDACTION_CENSOR } from "./log-redaction";

export interface LogContext {
  request_id?: string;
  trace_id?: string;
}

const store = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = store.getStore();
  return store.run({ ...parent, ...context }, fn);
}

export function getLogContext(): LogContext {
  return store.getStore() ?? {};
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
    // `mixin` context (request_id, trace_id) bypasses hooks but only ever holds
    // generated ids.
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((argument) => scrubTelemetry(argument)) as typeof args);
      },
    },
    redact: { paths: [...LOG_REDACTION_PATHS], censor: REDACTION_CENSOR },
    mixin: () => ({ ...getLogContext() }),
    ...(process.env.LOG_FORMAT === "pretty" ? { transport: { target: "pino-pretty" } } : {}),
  };
}

export const rootLogger: Logger = pino(baseLoggerOptions());

export function getLogger(): Logger {
  return rootLogger;
}
