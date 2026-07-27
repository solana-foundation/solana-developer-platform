/**
 * Observability (Sentry) abstraction.
 *
 * This module exposes the small API shape used by application code so tests can
 * inject lightweight implementations while production uses `@sentry/node`.
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
 * diverge. Requires a DSN and a production NODE_ENV, so local development does
 * not ship telemetry even when a DSN is present. Mirrors sdp-web's NODE_ENV
 * gate and fails closed anywhere NODE_ENV is unset.
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
