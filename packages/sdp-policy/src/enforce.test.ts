import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EffectiveWalletPolicy, PolicyEvaluation, WalletOperationEnvelope } from "@sdp/types";
import { enforceWalletOperationPolicy } from "./enforce";
import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "./evaluate";
import type {
  CreateWalletOperationInput,
  PolicyEnforcementStore,
  RecordPolicyEvaluationInput,
} from "./ports";
import { operation, walletPolicy } from "./test-support";

interface FakeStoreCall {
  method: string;
  args: unknown[];
}

/**
 * In-memory {@link PolicyEnforcementStore} recording every call, with
 * per-method failure injection.
 *
 * @param effectiveWalletPolicy - The wallet policy every load resolves to.
 * @param failures - Methods that throw when invoked.
 * @returns The store plus its call log.
 */
function fakeStore(
  effectiveWalletPolicy: EffectiveWalletPolicy,
  failures: Partial<Record<keyof PolicyEnforcementStore, Error>>
) {
  const calls: FakeStoreCall[] = [];
  const record = (method: keyof PolicyEnforcementStore, args: unknown[]) => {
    calls.push({ method, args });
    const failure = failures[method];
    if (failure) {
      throw failure;
    }
  };

  const store: PolicyEnforcementStore = {
    async createWalletOperation(input: CreateWalletOperationInput) {
      record("createWalletOperation", [input]);
      return { ...operation, status: input.status === undefined ? "created" : input.status };
    },
    async loadEffectivePolicies(op: WalletOperationEnvelope) {
      record("loadEffectivePolicies", [op]);
      return { walletPolicy: effectiveWalletPolicy, apiKeyPolicy: null };
    },
    async createApprovalRequest(input) {
      record("createApprovalRequest", [input]);
      return { id: "apr_1", status: "pending" as const };
    },
    async recordPolicyEvaluation(input: RecordPolicyEvaluationInput) {
      record("recordPolicyEvaluation", [input]);
      return {
        id: "peval_1",
        walletOperationId: input.walletOperationId,
        walletPolicyRevisionId: input.walletPolicyRevisionId,
        apiKeyPolicyRevisionId: input.apiKeyPolicyRevisionId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reason: input.reason,
        matchedRules: input.matchedRules.map((rule) => ({ ...rule })),
        evaluationContext: input.evaluationContext,
        requiresApproval: input.requiresApproval,
        approvalRequestId: input.approvalRequestId,
        createdAt: "2026-06-18T00:00:00.000Z",
      } satisfies PolicyEvaluation;
    },
    async updateWalletOperationStatus(walletOperationId, status) {
      record("updateWalletOperationStatus", [walletOperationId, status]);
      return { status, updatedAt: "2026-06-18T00:00:01.000Z" };
    },
    async failApprovalRequest(op, approvalRequestId) {
      record("failApprovalRequest", [op, approvalRequestId]);
    },
  };

  return { store, calls };
}

const enforcementInput: CreateWalletOperationInput = {
  organizationId: operation.organizationId,
  projectId: operation.projectId,
  walletId: operation.walletId,
  operationFamily: operation.operationFamily,
  operationType: operation.operationType,
  legs: [],
};

describe("enforceWalletOperationPolicy", () => {
  it("records, evaluates, and transitions an allowed operation to evaluated", async () => {
    const { store, calls } = fakeStore(IMPLICIT_DEFAULT_ALLOW_POLICY, {});

    const enforcement = await enforceWalletOperationPolicy(store, enforcementInput);

    assert.equal(enforcement.evaluation.decision, "allow");
    assert.equal(enforcement.operation.status, "evaluated");
    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "createWalletOperation",
        "loadEffectivePolicies",
        "recordPolicyEvaluation",
        "updateWalletOperationStatus",
      ]
    );
  });

  it("creates an approval request and parks the operation pending approval", async () => {
    const { store, calls } = fakeStore(
      walletPolicy([
        { id: "grp-rule", kind: "approval", families: ["payment"], approvalGroupId: "grp_1" },
      ]),
      {}
    );

    const enforcement = await enforceWalletOperationPolicy(store, enforcementInput);

    assert.equal(enforcement.evaluation.decision, "approval_required");
    assert.equal(enforcement.evaluation.approvalRequestId, "apr_1");
    assert.equal(enforcement.operation.status, "pending_approval");
    const approvalCall = calls.find((call) => call.method === "createApprovalRequest");
    assert.partialDeepStrictEqual(approvalCall?.args[0], {
      organizationId: operation.organizationId,
      walletOperationId: operation.id,
      approvalGroupId: "grp_1",
      provider: "future-provider",
    });
  });

  it("returns a denied decision instead of throwing and marks the operation failed", async () => {
    const { store } = fakeStore(walletPolicy([{ kind: "always", action: "deny" }]), {});

    const enforcement = await enforceWalletOperationPolicy(store, enforcementInput);

    assert.equal(enforcement.evaluation.decision, "deny");
    assert.equal(enforcement.operation.status, "failed");
  });

  it("compensates the operation to failed when evaluation persistence fails", async () => {
    const boom = new Error("evaluation write failed");
    const { store, calls } = fakeStore(IMPLICIT_DEFAULT_ALLOW_POLICY, {
      recordPolicyEvaluation: boom,
    });

    await assert.rejects(enforceWalletOperationPolicy(store, enforcementInput), boom);
    assert.partialDeepStrictEqual(calls.at(-1), {
      method: "updateWalletOperationStatus",
      args: [operation.id, "failed"],
    });
  });

  it("compensates through the approval request when one was created", async () => {
    const boom = new Error("evaluation write failed");
    const { store, calls } = fakeStore(
      walletPolicy([{ kind: "approval", families: ["payment"] }]),
      {
        recordPolicyEvaluation: boom,
      }
    );

    await assert.rejects(enforceWalletOperationPolicy(store, enforcementInput), boom);
    assert.partialDeepStrictEqual(calls.at(-1), {
      method: "failApprovalRequest",
      args: [{ id: operation.id }, "apr_1"],
    });
  });

  it("aggregates the original error with a compensation failure", async () => {
    const boom = new Error("evaluation write failed");
    const cleanupBoom = new Error("cleanup also failed");
    const { store } = fakeStore(IMPLICIT_DEFAULT_ALLOW_POLICY, {
      recordPolicyEvaluation: boom,
      updateWalletOperationStatus: cleanupBoom,
    });

    await assert.rejects(
      enforceWalletOperationPolicy(store, enforcementInput),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [boom, cleanupBoom]);
        return true;
      }
    );
  });
});
