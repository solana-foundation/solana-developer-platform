import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger, type LoggerOptions } from "pino";

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
    ? { type: value.name, message: value.message, stack: value.stack }
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
    mixin: () => ({ ...getLogContext() }),
    ...(process.env.LOG_FORMAT === "pretty" ? { transport: { target: "pino-pretty" } } : {}),
  };
}

export const rootLogger: Logger = pino(baseLoggerOptions());

export function getLogger(): Logger {
  return rootLogger;
}
