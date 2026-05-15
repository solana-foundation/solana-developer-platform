/**
 * Node Observability — wraps @sentry/node.
 *
 * Used by the future Node entrypoint (src/server.ts, HOO-510). Node has no
 * per-request wrapper analogous to Cloudflare's `withSentry`; instead the
 * entrypoint calls `initNodeSentry(getSentryOptions(env))` once at startup
 * and then uses the shared `Observability` API.
 *
 * `nodeObservability.*` methods throw if invoked before `initNodeSentry()`
 * has run. The @sentry/node SDK otherwise silently no-ops when not
 * initialised, which would let a misordered server.ts boot drop every
 * captured error without any signal. We'd rather fail loud at the first
 * stray call than ship in production with errors quietly disappearing.
 */

import * as Sentry from "@sentry/node";
import type { MonitorOptions, Observability, SentryOptions } from "./observability";

let initialized = false;

export function initNodeSentry(opts: SentryOptions): void {
  // Intentional: when DSN is unset we skip `Sentry.init` entirely rather
  // than calling it with `{ enabled: false }`. The latter would still
  // create a client and wire up scope/breadcrumb machinery, just suppress
  // sending. CF behaves differently — `Sentry.withSentry` still wraps the
  // handler and sets up scopes/error boundaries even without a DSN; only
  // transport is skipped. We accept that asymmetry: Phase 1 has no caller
  // that needs ambient scopes when Sentry is "off". Revisit if a future
  // caller wants breadcrumb-only behaviour with the SDK initialised.
  initialized = true;
  if (!opts.enabled) {
    return;
  }
  Sentry.init(opts);
}

function ensureInitialized(): void {
  if (!initialized) {
    throw new Error("nodeObservability used before initNodeSentry() was called");
  }
}

export const nodeObservability: Observability = {
  captureException(err) {
    ensureInitialized();
    Sentry.captureException(err);
  },
  withScope(cb) {
    ensureInitialized();
    Sentry.withScope((scope) => {
      cb(scope);
    });
  },
  withMonitor<T>(slug: string, fn: () => Promise<T>, opts: MonitorOptions): Promise<T> {
    ensureInitialized();
    return Sentry.withMonitor(slug, fn, opts) as Promise<T>;
  },
};
