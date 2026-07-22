/**
 * Background task abstraction.
 *
 * Request handlers should not await fire-and-forget work, but the process must
 * still track it so graceful shutdown can drain in-flight promises.
 *
 * Call-sites depend on this interface; `server.ts` instantiates the Node
 * implementation and adapts Hono's request context to it.
 */

export interface BackgroundRunner {
  /**
   * Register a promise that should run to completion in the background. Does
   * not block the caller. Errors are swallowed by the runtime — log inside the
   * promise itself if you care.
   */
  run(promise: Promise<unknown>): void;

  /**
   * Wait for all currently-tracked promises to settle. The server calls this
   * on SIGTERM before exiting.
   */
  awaitAll(): Promise<void>;

  /**
   * True while awaitAll() is in flight. Useful for diagnostics and for callers
   * that want to refuse new work once shutdown has started.
   */
  readonly draining: boolean;
}
