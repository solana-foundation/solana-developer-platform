import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { OPERATION_WORKER_BUDGET_MS } from "@/services/earn/operation-worker-budget";
import * as strategyOperations from "@/services/earn/strategy-operations.service";
import * as operationsService from "@/services/operations.service";
import * as operationsPrincipal from "@/services/operations-principal";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { reconcileOperations } from "@/test/helpers/reconcile-operations";

const mocks = {
  candidates: vi.fn(),
  claim: vi.fn(),
  advance: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
  getAttempt: vi.fn(),
  transition: vi.fn(),
  log: vi.fn(),
};

let now: number;
const scoped = () =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env));
beforeEach(() => {
  vi.resetAllMocks();
  const service = operationsService.createOperationsService(env);
  vi.spyOn(service.repository, "claimRecovery").mockImplementation(mocks.claim);
  vi.spyOn(service.repository, "claimNextRecovery").mockImplementation(async () => {
    const candidate = (await mocks.candidates()).shift();
    if (candidate === undefined) return null;
    const scope: OperationScope = {
      organizationId: candidate.organizationId,
      projectId: candidate.projectId,
      environment: "sandbox",
    };
    return { scope, claim: await mocks.claim(scope, candidate.id) };
  });
  vi.spyOn(service.repository, "releaseRecovery").mockImplementation(mocks.release);
  vi.spyOn(service.repository, "get").mockImplementation(mocks.get);
  vi.spyOn(service.repository, "getAttempt").mockImplementation(mocks.getAttempt);
  vi.spyOn(service, "transition").mockImplementation(mocks.transition);
  vi.spyOn(operationsService, "createOperationsService").mockReturnValue(service);
  vi.spyOn(strategyOperations, "advanceEarnOperation").mockImplementation(mocks.advance);
  vi.spyOn(operationsPrincipal, "runAsRecordedOperationPrincipal").mockImplementation(
    (_env, _scope, _claim, work) => work()
  );
  vi.spyOn(getLogger(), "error").mockImplementation(mocks.log);
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
