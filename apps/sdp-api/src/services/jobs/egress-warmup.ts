/**
 * A fresh Cloud Run job instance can spend its first minutes with no working
 * external egress while Cloud NAT programs ports for it; every outbound call
 * silently times out until then. Waiting for one probe to succeed before the
 * reconciliation ticks start lets a single check bridge the window for every
 * downstream call instead of each call site retrying through it.
 */
export async function waitForEgress(params: {
  probe: () => Promise<unknown>;
  deadlineMs: number;
  intervalMs: number;
  stopSignal: AbortSignal;
}): Promise<{ outcome: "ready" | "deadline" | "stopped"; elapsedMs: number; attempts: number }> {
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    if (params.stopSignal.aborted) {
      return { outcome: "stopped", elapsedMs: Date.now() - startedAt, attempts };
    }
    attempts += 1;
    try {
      await params.probe();
      return { outcome: "ready", elapsedMs: Date.now() - startedAt, attempts };
    } catch {
      if (Date.now() - startedAt >= params.deadlineMs) {
        return { outcome: "deadline", elapsedMs: Date.now() - startedAt, attempts };
      }
      if (params.stopSignal.aborted) {
        return { outcome: "stopped", elapsedMs: Date.now() - startedAt, attempts };
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          params.stopSignal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, params.intervalMs);
        params.stopSignal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
