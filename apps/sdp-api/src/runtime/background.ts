/**
 * Runtime-neutral background task abstraction.
 *
 * Both Cloudflare and Node runtimes have a notion of "fire-and-forget" work
 * that the request handler shouldn't await but that the runtime needs to keep
 * alive past the response. CF expresses this via `ctx.waitUntil`; Node has no
 * primitive — promises run in the background until the process exits. The Node
 * impl bridges the gap by tracking in-flight promises so a SIGTERM handler can
 * drain them before the process dies.
 *
 * Call-sites depend on this interface; the right impl is instantiated at the
 * entrypoint (CF uses WorkersBackgroundRunner, Node will use NodeBackgroundRunner
 * once `server.ts` lands in HOO-511).
 */

export interface BackgroundRunner {
  /**
   * Register a promise that should run to completion in the background. Does
   * not block the caller. Errors are swallowed by the runtime — log inside the
   * promise itself if you care.
   */
  run(promise: Promise<unknown>): void;

  /**
   * Wait for all currently-tracked promises to settle. CF doesn't need this
   * (the platform handles it); Node calls it on SIGTERM to drain in-flight
   * work before exit. Implementations where the runtime drains automatically
   * may return immediately.
   */
  awaitAll(): Promise<void>;

  /**
   * True while awaitAll() is in flight. Useful for diagnostics and for callers
   * that want to refuse new work once shutdown has started. CF runtimes hand
   * drain back to the platform and always report false.
   */
  readonly draining: boolean;
}
