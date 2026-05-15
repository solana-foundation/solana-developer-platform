/**
 * Cloudflare Workers Observability — wraps @sentry/cloudflare.
 *
 * Sentry's CF SDK ties its state to the worker's per-request lifecycle via
 * `withSentry(getOptions, worker)`, which is exported separately because it's
 * the entrypoint wrapper and has no analog on Node (Node uses Sentry.init at
 * startup).
 */

import * as Sentry from "@sentry/cloudflare";
import type { MonitorOptions, Observability } from "./observability";

export const cloudflareObservability: Observability = {
  captureException(err) {
    Sentry.captureException(err);
  },
  withScope(cb) {
    Sentry.withScope((scope) => {
      cb(scope);
    });
  },
  withMonitor<T>(slug: string, fn: () => Promise<T>, opts: MonitorOptions): Promise<T> {
    return Sentry.withMonitor(slug, fn, opts) as Promise<T>;
  },
};

export const withSentry = Sentry.withSentry;
