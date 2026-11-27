import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { conflict } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import * as strategyOperations from "@/services/earn/strategy-operations.service";
import * as operationsService from "@/services/operations.service";
import * as operationsPrincipal from "@/services/operations-principal";
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

describe("operation claim recovery", () => {
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
