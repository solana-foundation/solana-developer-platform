// Registry of open SSE streams, so shutdown can release them BEFORE awaiting
// server.close(): an open stream is an in-flight request, and without this the close
// would hang until the shutdown watchdog force-exits. Dependency-free on purpose.

const active = new Set<() => void>();

/** Track an open stream's close callback; returns the deregistration function. */
export function registerSseStream(close: () => void): () => void {
  active.add(close);
  return () => active.delete(close);
}

/** Release every open stream (shutdown). Callbacks must be idempotent. */
export function closeAllSseStreams(): void {
  for (const close of [...active]) {
    close();
  }
}

/** Open-stream count, for health/observability logging. */
export function activeSseCount(): number {
  return active.size;
}
