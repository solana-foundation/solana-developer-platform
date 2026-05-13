/**
 * Node BackgroundRunner — tracks in-flight promises so SIGTERM can drain them.
 *
 * Unlike Cloudflare, the Node runtime gives the process no help keeping
 * "fire-and-forget" work alive past the response. If the process exits while
 * a background promise is mid-flight, the work is lost. The Node server
 * (HOO-511) wires SIGTERM → server.close() → bg.awaitAll() → process.exit
 * so pending background work has a chance to finish before shutdown.
 *
 * Errors inside tracked promises are swallowed silently here — the same
 * behaviour as CF's ctx.waitUntil. Log inside the promise if you care.
 *
 * Not wired anywhere in HOO-507; this impl ships now so HOO-511 doesn't have
 * to introduce both the runner and the server entrypoint in the same change.
 */

import type { BackgroundRunner } from "./background";

export class NodeBackgroundRunner implements BackgroundRunner {
  private readonly pending = new Set<Promise<unknown>>();

  run(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
  }

  async awaitAll(): Promise<void> {
    // Snapshot — drain reflects in-flight work at call time; new tasks
    // added after this point are not awaited.
    await Promise.allSettled([...this.pending]);
  }
}
