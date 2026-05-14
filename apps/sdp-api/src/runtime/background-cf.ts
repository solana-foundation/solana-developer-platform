/**
 * Cloudflare Workers BackgroundRunner — wraps `ctx.waitUntil`.
 *
 * The Workers runtime guarantees the worker stays alive until every promise
 * passed to ctx.waitUntil settles, so awaitAll has nothing to do here.
 *
 * ExecutionContext is request-scoped (one per fetch/scheduled invocation), so
 * a new instance is created per invocation at the entrypoint.
 */

import type { BackgroundRunner } from "./background";

export class WorkersBackgroundRunner implements BackgroundRunner {
  // Drain is platform-managed on Workers; this flag is part of the interface
  // contract but never flips here.
  readonly draining = false;

  constructor(private readonly ctx: ExecutionContext) {}

  run(promise: Promise<unknown>): void {
    this.ctx.waitUntil(promise);
  }

  async awaitAll(): Promise<void> {
    // No-op: the Workers platform drains waitUntil promises automatically
    // before the worker is reclaimed.
  }
}
