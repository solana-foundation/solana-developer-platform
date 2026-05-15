/**
 * Runtime-neutral observability (Sentry) abstraction.
 *
 * @sentry/cloudflare and @sentry/node share most of their public API surface,
 * but cannot be imported into the same bundle: cloudflare relies on the
 * Workers runtime, node pulls native modules. This module exposes only the
 * shared API shape and runtime-neutral helpers. Concrete implementations live
 * in observability-cf.ts (HOO-508) and observability-node.ts (wired up in
 * HOO-510 when server.ts lands).
 */

import type { Env } from "@/types/env";

export interface ObservabilityScope {
  setTag(key: string, value: string | undefined): void;
  setUser(user: { id: string }): void;
}

export interface MonitorOptions {
  schedule: { type: "crontab"; value: string };
}

export interface Observability {
  captureException(err: unknown): void;
  withScope(cb: (scope: ObservabilityScope) => void): void;
  withMonitor<T>(slug: string, fn: () => Promise<T>, opts: MonitorOptions): Promise<T>;
}

export interface SentryOptions {
  dsn?: string;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
}

/**
 * Canonical "is Sentry configured?" check. Call this anywhere that needs to
 * branch on whether Sentry is enabled — never inline `env.SENTRY_DSN?.trim()`
 * at call-sites, since the definition may grow (e.g. an explicit
 * `SENTRY_ENABLED` flag) and inline checks would silently diverge.
 */
export function isSentryEnabled(env: Pick<Env, "SENTRY_DSN">): boolean {
  return Boolean(env.SENTRY_DSN?.trim());
}

function parseSentryTraceSampleRate(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}

export function getSentryOptions(env: Env): SentryOptions {
  const dsn = env.SENTRY_DSN?.trim();
  const defaultTraceSampleRate = env.ENVIRONMENT === "production" ? 0.1 : 1;
  const tracesSampleRate = parseSentryTraceSampleRate(
    env.SENTRY_TRACES_SAMPLE_RATE,
    defaultTraceSampleRate
  );

  return {
    ...(dsn ? { dsn } : {}),
    enabled: Boolean(dsn),
    environment: env.ENVIRONMENT,
    tracesSampleRate,
    sendDefaultPii: false,
  };
}
