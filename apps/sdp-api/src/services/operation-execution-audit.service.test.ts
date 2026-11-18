import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import type { AppContext } from "@/routes/earn/context";
import type { AuditIntent, AuditLogEntry } from "./audit.service";
import { acceptOperationExecution } from "./operation-execution-audit.service";

const mocks = vi.hoisted(() => ({
  queue: vi.fn(),
  link: vi.fn(),
  getAttempt: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  query: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/db/client", () => ({ getDb: () => ({ queryOne: mocks.query }) }));
vi.mock("@/db/repositories/operations.repository", () => ({
  createOperationsRepository: () => ({
    requestExecution: mocks.queue,
    requestExecutionWithin: mocks.link,
    getAttempt: mocks.getAttempt,
  }),
}));
vi.mock("./audit.service", () => ({
  AuditService: class {
    beginCriticalWithin = mocks.begin;
    completeCritical = mocks.complete;
  },
}));
vi.mock("@/runtime/logger", () => ({ getLogger: () => ({ error: mocks.error }) }));

const scope: OperationScope = {
  organizationId: "organization",
  projectId: "project",
  environment: "sandbox",
};
const context = {} as AppContext;
let claim: OperationClaim;

beforeEach(() => {
  vi.resetAllMocks();
  claim = {
    operation: {
      id: "operation",
      kind: "earn.deposit",
      actionId: "action",
      version: 1,
      status: "prepared",
    },
    attempt: { id: "attempt", principal: { kind: "api_key", apiKeyId: "key" } },
    purpose: "execute",
    recoveryRequired: false,
  } as OperationClaim;
  mocks.query.mockResolvedValue(null);
  mocks.link.mockResolvedValue(true);
  mocks.complete.mockResolvedValue(true);
  mocks.begin.mockImplementation(
    async (_c, entry: AuditLogEntry, link: (tx: unknown, id: string) => Promise<boolean>) => {
      const inserted = await link({}, "intent");
      return inserted ? ({ id: "intent", entry } satisfies AuditIntent) : null;
    }
  );
});

describe("operation execution audit admission", () => {
  it("atomically links a deposit's queue request to the audit intent before recording accepted, never settled", async () => {
    await acceptOperationExecution(context, scope, claim);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.link).toHaveBeenCalledWith({}, scope, claim, "intent", undefined);
    expect(mocks.complete).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        id: "intent",
        entry: expect.objectContaining({
          action: "submit",
          resourceType: "earn_operation",
          resourceId: "operation",
          apiKeyId: "key",
        }),
      }),
      {
        metadata: {
          executionStage: "accepted",
          operationStatus: "queued",
          sideEffectsPerformedByRequest: false,
          settlementObserved: false,
        },
      }
    );
  });

  it("never queues a deposit when its audit intent cannot persist", async () => {
    mocks.begin.mockRejectedValue(new Error("audit unavailable"));
    await expect(acceptOperationExecution(context, scope, claim)).rejects.toThrow(
      "audit unavailable"
    );
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["withdrawal", "cancellation"])(
    "preserves durable %s acceptance during an audit outage",
    async (kind) => {
      if (kind === "withdrawal") claim.operation.kind = "earn.withdraw";
      else claim.purpose = "cancel";
      mocks.begin.mockRejectedValue(new Error("audit unavailable"));
      await expect(acceptOperationExecution(context, scope, claim)).resolves.toBeUndefined();
      expect(mocks.queue).toHaveBeenCalledWith(scope, claim, undefined);
      expect(mocks.queue.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.begin.mock.invocationCallOrder[0] ?? 0
      );
      expect(mocks.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "operation_acceptance_audit_failed" }),
        expect.any(String)
      );
    }
  );

  it("never reports accepted deposit execution as refused when only the outcome read fails", async () => {
    mocks.query.mockRejectedValue(new Error("audit outcome read unavailable"));
    await expect(acceptOperationExecution(context, scope, claim)).resolves.toBeUndefined();
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an existing action's accepted outcome on replay", async () => {
    mocks.link.mockResolvedValue(false);
    mocks.getAttempt.mockResolvedValue({ auditIntentId: "existing-intent" });
    mocks.query.mockResolvedValue({ present: 1 });
    await acceptOperationExecution(context, scope, claim);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [
      scope.organizationId,
      claim.operation.id,
      "existing-intent",
    ]);
  });
});
