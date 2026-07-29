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

export function applyLogContext(logger: Logger): Logger {
  const context = getLogContext();
  return Object.keys(context).length > 0 ? logger.child(context) : logger;
}

function resolveOptions(): LoggerOptions {
  const format =
    process.env.LOG_FORMAT ?? (process.env.ENVIRONMENT === "development" ? "pretty" : "json");

  return {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    messageKey: "message",
    ...(format === "pretty" ? { transport: { target: "pino-pretty" } } : {}),
  };
}

export const rootLogger: Logger = pino(resolveOptions());

export function getLogger(): Logger {
  return applyLogContext(rootLogger);
}
