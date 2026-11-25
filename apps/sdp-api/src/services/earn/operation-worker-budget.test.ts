import { describe, expect, it } from "vitest";
import { MAX_CUSTODY_SIGNING_TIMEOUT_MS } from "@/services/custody/signing/signing-timeout";
import {
  OPERATION_WORKER_BOUNDARY_MS,
  OPERATION_WORKER_BUDGET_MS,
  OPERATION_WORKER_LEASE_MS,
  OperationWorkerBudget,
} from "./operation-worker-budget";

describe("operation worker budget", () => {
  it("reserves the whole custody and sponsor call before starting signing", () => {
    let elapsed = 0;
    const budget = new OperationWorkerBudget(() => elapsed);
    elapsed = 10_000;
    expect(() =>
      budget.assertCanStart(MAX_CUSTODY_SIGNING_TIMEOUT_MS + OPERATION_WORKER_BOUNDARY_MS)
    ).not.toThrow();
    elapsed += 1;
    expect(() =>
      budget.assertCanStart(MAX_CUSTODY_SIGNING_TIMEOUT_MS + OPERATION_WORKER_BOUNDARY_MS)
    ).toThrow("worker yielded");
  });

  it("leaves a bounded call and persistence margin inside the claim lease", () => {
    expect(OPERATION_WORKER_BUDGET_MS + OPERATION_WORKER_BOUNDARY_MS).toBeLessThan(
      OPERATION_WORKER_LEASE_MS
    );
    let elapsed = 0;
    const budget = new OperationWorkerBudget(() => elapsed);
    elapsed = OPERATION_WORKER_BUDGET_MS - OPERATION_WORKER_BOUNDARY_MS;
    expect(() => budget.assertCanStart()).not.toThrow();
    elapsed += 1;
    expect(() => budget.assertCanStart()).toThrow("recovery will resume");
  });
});
