import { isSdpProgressOperationStatus, type Operation } from "@sdp/types/operations";
import { EarnApiError } from "./earn-client";

/** The foreground budget is one batch per second, independent of activity row count. */
export const EARN_OPERATION_OBSERVATION_MS = 1_000;
const MAX_BATCH_SIZE = 100;
const FAST_WINDOW_MS = 30_000;
const WATCH_WINDOW_MS = 120_000;
const BACKGROUND_MS = 5_000;
const MAX_RETRY_MS = 30_000;

interface Watch {
  nextAt: number;
  startedAt: number;
  failures: number;
}

interface ObserverPorts {
  read: (ids: readonly string[]) => Promise<readonly Operation[]>;
  publish: (operations: readonly Operation[]) => Promise<void>;
  reportError: (error: Error | undefined) => Promise<void>;
  visible: () => boolean;
}

/**
 * One cache-scoped, single-flight observer for recent user actions and missing feed rows.
 * Provider waits stay on the shared feed. A closed dialog never owns execution or recovery.
 */
export class EarnOperationObserver {
  private readonly watches = new Map<string, Watch>();
  private consumers = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(private readonly ports: ObserverPorts) {}

  /** Keep observation alive while the feed or an action dialog uses its cache. */
  retain(): () => void {
    this.consumers += 1;
    this.schedule();
    return () => {
      this.consumers -= 1;
      if (this.consumers === 0 && this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** Follow a submitted user action quickly; terminal and provider-wait observations stop it. */
  observe(operation: Operation, foreground = false): void {
    if (!isSdpProgressOperationStatus(operation.status)) {
      this.watches.delete(operation.id);
      return;
    }
    if (foreground) this.recover([operation.id]);
  }

  /** Reopening active work restores its short watch without bypassing server retry limits. */
  focus(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    watch.startedAt = Date.now();
    if (watch.failures === 0) watch.nextAt = Date.now();
    this.schedule();
  }

  /** Resolve disappeared active rows in bounded batches, including old completed withdrawals. */
  recover(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.watches.has(id)) {
        const now = Date.now();
        this.watches.set(id, { nextAt: now, startedAt: now, failures: 0 });
      }
    }
    this.schedule();
  }

  private delayFailedBatch(due: readonly (readonly [string, Watch])[], cause: unknown): void {
    for (const [id, watch] of due) {
      if (this.watches.get(id) !== watch) continue;
      watch.failures += 1;
      const retryAfter = cause instanceof EarnApiError ? cause.retryAfterSeconds : undefined;
      watch.nextAt =
        Date.now() +
        Math.max(
          Math.min(2 ** watch.failures * 1_000, MAX_RETRY_MS),
          retryAfter === undefined ? 0 : retryAfter * 1_000
        );
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.running || this.consumers === 0 || this.watches.size === 0)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.readDue();
    }, EARN_OPERATION_OBSERVATION_MS);
  }

  private async readDue(): Promise<void> {
    if (this.consumers === 0) return;
    if (!this.ports.visible()) {
      this.schedule();
      return;
    }
    const now = Date.now();
    const due = [...this.watches]
      .filter(([, watch]) => watch.nextAt <= now)
      .sort((left, right) => left[1].nextAt - right[1].nextAt)
      .slice(0, MAX_BATCH_SIZE);
    if (due.length === 0) {
      this.schedule();
      return;
    }
    this.running = true;
    try {
      const operations = await this.ports.read(due.map(([id]) => id));
      const observed = new Map(operations.map((operation) => [operation.id, operation]));
      const missing = due.filter(([id]) => !observed.has(id));
      const missingError =
        missing.length > 0 ? new Error("An operation observation is unavailable") : undefined;
      if (missingError) this.delayFailedBatch(missing, missingError);
      for (const [id, watch] of due) {
        if (this.watches.get(id) !== watch) continue;
        const operation = observed.get(id);
        if (operation === undefined) continue;
        if (!isSdpProgressOperationStatus(operation.status)) {
          this.watches.delete(id);
        } else {
          watch.failures = 0;
          watch.nextAt = Date.now() + observationCadence(Date.now() - watch.startedAt);
        }
      }
      if (this.consumers > 0) {
        await this.ports.publish(operations);
        await this.ports.reportError(missingError);
      }
    } catch (cause) {
      this.delayFailedBatch(due, cause);
      if (this.consumers > 0)
        await this.ports.reportError(
          cause instanceof Error ? cause : new Error("Operation observation failed")
        );
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}

function observationCadence(age: number): number {
  if (age < FAST_WINDOW_MS) return EARN_OPERATION_OBSERVATION_MS;
  if (age < WATCH_WINDOW_MS) return BACKGROUND_MS;
  return 15_000;
}
