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
  // Refcount, not boolean: concurrent awaitAll() calls each increment on entry
  // and decrement on exit, so `draining` reports true for the entire window
  // any drain is in flight. A boolean would be cleared by the first drain's
  // finally even if a second drain were still running.
  private drainCount = 0;
  // Once any drain has completed, the runner is sealed: run() will refuse new
  // work the same way it does during a drain. SIGTERM is a one-way event in
  // production — the runner is built for that, not for reuse — and sealing
  // closes the silent-tracking window between `await bg.awaitAll()` returning
  // and `process.exit()` being called by the SIGTERM handler.
  private sealed = false;

  get draining(): boolean {
    return this.drainCount > 0;
  }

  run(promise: Promise<unknown>): void {
    if (this.drainCount > 0 || this.sealed) {
      // The promise was already started by the caller; we can't undo its side
      // effects, only choose not to track it. Either the current drain's
      // snapshot is closed (drainCount > 0), or all drains have completed and
      // the runner is sealed (sealed). Warn so the leak is visible, and surface
      // any rejection separately — `.catch()` here both attaches the handler
      // that logs and prevents an unhandledRejection.
      const state = this.drainCount > 0 ? "during awaitAll() drain" : "after awaitAll() completed";
      console.warn(
        `[NodeBackgroundRunner] run() called ${state} — task not tracked (side effects already in flight)`
      );
      promise.catch((err) => {
        console.warn("[NodeBackgroundRunner] untracked task rejected:", err);
      });
      return;
    }
    // .catch(() => undefined) before .finally absorbs rejections at registration
    // time, matching CF waitUntil's swallow-and-forget semantics. Without it, a
    // rejecting task stays unhandled until awaitAll's Promise.allSettled picks
    // it up — which never happens if the process exits before drain.
    const tracked = promise
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  async awaitAll(): Promise<void> {
    // Snapshot — drain reflects in-flight work at call time. Late tasks are
    // refused by the draining guard above, not silently lost.
    this.drainCount++;
    try {
      await Promise.allSettled([...this.pending]);
    } finally {
      // Seal before decrementing the refcount so the guard never sees a
      // moment where both `drainCount === 0` and `sealed === false`.
      this.sealed = true;
      this.drainCount--;
    }
  }
}
