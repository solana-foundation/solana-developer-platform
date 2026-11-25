import { serviceUnavailable } from "@/lib/errors";

/** The action's lease outlives its budget and one final bounded provider call. */
export const OPERATION_WORKER_LEASE_MS = 180_000;
/** A worker yields retained work before its claim or the cron slot can expire. */
export const OPERATION_WORKER_BUDGET_MS = 120_000;
/** Existing Earn RPC, sponsor, and provider calls each have a 20-second ceiling. */
export const OPERATION_WORKER_BOUNDARY_MS = 20_000;

/** Guard each fresh boundary; never race an entire money workflow. */
export class OperationWorkerBudget {
  private readonly startedAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  /** Reserve the boundary's full bound before allowing its side effects. */
  assertCanStart(boundaryBudgetMs = OPERATION_WORKER_BOUNDARY_MS): void {
    if (this.now() - this.startedAt + boundaryBudgetMs > OPERATION_WORKER_BUDGET_MS) {
      throw serviceUnavailable("The worker yielded this operation; recovery will resume it");
    }
  }
}

/** One absolute action budget shared by its provider, signer, and send stages. */
export function createOperationWorkerBudget(): OperationWorkerBudget {
  return new OperationWorkerBudget();
}
