import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { conflict } from "@/lib/errors";
import { OPERATION_WORKER_BUDGET_MS } from "@/services/earn/operation-worker-budget";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { reconcileOperations } from "./reconcile-operations";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  claim: vi.fn(),
  advance: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
  getAttempt: vi.fn(),
  transition: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/services/operations.service", () => ({
  createOperationsService: () => ({
    repository: {
      claimRecovery: mocks.claim,
      listDueRecovery: mocks.candidates,
      releaseRecovery: mocks.release,
      get: mocks.get,
      getAttempt: mocks.getAttempt,
    },
    transition: mocks.transition,
  }),
}));
vi.mock("@/services/earn/strategy-operations.service", () => ({
  advanceEarnOperation: mocks.advance,
  isTerminalOperation: (operation: { status: string }) =>
    ["completed", "failed", "cancelled"].includes(operation.status),
}));
vi.mock("@/services/operations-principal", () => ({
  runAsRecordedOperationPrincipal: (
    _env: Env,
    _scope: OperationScope,
    _claim: unknown,
    work: () => Promise<void>
  ) => work(),
}));
vi.mock("@/runtime/logger", () => ({ getLogger: () => ({ error: mocks.log }) }));

let now: number;
const scoped = () =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env));
beforeEach(() => {
  vi.resetAllMocks();
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.candidates.mockResolvedValue(
    ["one", "two", "three"].map((id) => ({ id, organizationId: "org", projectId: "project" }))
  );
  mocks.claim.mockImplementation(async (_scope: OperationScope, id: string) => ({
    operation: { id },
    token: id,
    fence: 1,
  }));
  mocks.get.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("operation worker run budget", () => {
  it("finishes the current action and leaves later candidates unclaimed when the budget expires", async () => {
    mocks.advance.mockImplementation(async () => {
      now += OPERATION_WORKER_BUDGET_MS;
    });
    await scoped();
    expect(mocks.claim).toHaveBeenCalledTimes(3);
    expect(mocks.advance).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it("never preclaims beyond four active workers", async () => {
    const gate = deferred<void>();
    mocks.candidates.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        organizationId: "org",
        projectId: "project",
      }))
    );
    mocks.advance.mockImplementation(async () => gate.promise);
    const run = scoped();
    await vi.waitFor(() => expect(mocks.advance).toHaveBeenCalledTimes(4));
    expect(mocks.claim).toHaveBeenCalledTimes(4);
    now += OPERATION_WORKER_BUDGET_MS;
    gate.resolve();
    await run;
    expect(mocks.claim).toHaveBeenCalledTimes(4);
    expect(mocks.release).toHaveBeenCalledTimes(4);
  });

  it("waits for other active workers if one lease or scheduling call fails", async () => {
    mocks.release.mockRejectedValueOnce(new Error("Scheduling unavailable"));
    await expect(scoped()).rejects.toThrow("1 operation recovery attempts failed");
    expect(mocks.advance).toHaveBeenCalledTimes(3);
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it("continues other recoveries when both advancement and its error projection fail", async () => {
    mocks.advance.mockRejectedValueOnce(new Error("Provider unavailable"));
    mocks.get.mockRejectedValueOnce(new Error("Projection unavailable"));
    await expect(scoped()).rejects.toThrow("1 operation recovery attempts failed");
    expect(mocks.advance).toHaveBeenCalledTimes(3);
    expect(mocks.release).toHaveBeenCalledTimes(3);
    expect(mocks.log).toHaveBeenCalledTimes(2);
  });

  it.each([
    { signedTransaction: null, dispatchStartedAt: null },
    {
      signedTransaction: "retained-signed-bytes",
      dispatchStartedAt: "already-started",
    },
  ])(
    "keeps uncertain failures under observation without offering replacement",
    async ({ signedTransaction, dispatchStartedAt }) => {
      mocks.advance.mockRejectedValueOnce(conflict("Expired", { reason: "transaction_expired" }));
      mocks.get.mockResolvedValueOnce({
        claimToken: "one",
        operation: { status: "queued", resourceRef: null },
      });
      mocks.getAttempt.mockResolvedValueOnce({ signedTransaction, dispatchStartedAt });
      await expect(scoped()).rejects.toThrow("1 operation recovery attempts failed");
      expect(mocks.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          status: "queued",
          nextAction: { type: "wait", reason: expect.any(String) },
        })
      );
      expect(mocks.getAttempt).not.toHaveBeenCalled();
    }
  );

  it("preserves a terminal outcome if advancement loses its response", async () => {
    mocks.advance.mockRejectedValueOnce(new Error("Response lost"));
    mocks.get.mockResolvedValueOnce({
      claimToken: "one",
      operation: { status: "failed", resourceRef: null },
    });
    await expect(scoped()).rejects.toThrow("1 operation recovery attempts failed");
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
