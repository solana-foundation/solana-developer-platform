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
 * branch on whether Sentry is enabled — never inline the env reads at
 * call-sites, since the definition may grow and inline checks would silently
 * diverge. Requires a DSN and a production NODE_ENV: wrangler statically
 * replaces `process.env.NODE_ENV` at build time ("development" under
 * `wrangler dev`, "production" on deploy), so local dev never ships telemetry
 * even though the Doppler-injected DSN reaches the worker env. Mirrors
 * sdp-web's NODE_ENV gate; fails closed anywhere NODE_ENV is unset.
 */
export function isSentryEnabled(env: Pick<Env, "SENTRY_DSN">): boolean {
  return Boolean(env.SENTRY_DSN?.trim()) && process.env.NODE_ENV === "production";
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
    enabled: isSentryEnabled(env),
    environment: env.ENVIRONMENT,
    tracesSampleRate,
    sendDefaultPii: false,
  };
}
