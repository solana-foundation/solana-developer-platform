import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDecimalAmounts } from "@sdp/solana/amount";
import type {
  EffectiveWalletPolicy,
  PolicyEvaluation,
  VelocityPolicyRule,
  WalletOperationEnvelope,
  WalletOperationStatus,
} from "@sdp/types";
import { parseIsoDurationMs } from "./duration";
import { enforceWalletOperationPolicy } from "./enforce";
import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "./evaluate";
import type {
  CreateWalletOperationInput,
  PolicyEnforcementStore,
  RecordPolicyEvaluationInput,
  VelocityCandidate,
} from "./ports";
import { operation, walletPolicy } from "./test-support";
import { type VelocityObservation, velocityObservationKeys } from "./velocity";

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
    async loadVelocityObservations(candidate, rules) {
      record("loadVelocityObservations", [candidate, rules]);
      return [];
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

interface LedgerRow {
  id: string;
  organizationId: string;
  custodyWalletId: string | null;
  apiKeyId: string | null;
  asset: string | null;
  amount: string | null;
  operationType: WalletOperationEnvelope["operationType"];
  status: WalletOperationStatus;
  createdAt: number;
}

/**
 * In-memory {@link PolicyEnforcementStore} with a real wallet-operation
 * ledger, so velocity windows sum what earlier enforcements recorded.
 *
 * @param effectiveWalletPolicy - The wallet policy every load resolves to.
 * @param now - The clock the ledger stamps rows with.
 * @returns The store plus its ledger.
 */
function ledgerStore(effectiveWalletPolicy: EffectiveWalletPolicy, now: () => number) {
  const ledger: LedgerRow[] = [];
  let sequence = 0;

  const store: PolicyEnforcementStore = {
    async createWalletOperation(input: CreateWalletOperationInput) {
      sequence += 1;
      const id = `wop_${sequence}`;
      ledger.push({
        id,
        organizationId: input.organizationId,
        custodyWalletId: input.custodyWalletId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        asset: input.asset ?? null,
        amount: input.amount ?? null,
        operationType: input.operationType,
        status: input.status ?? "created",
        createdAt: now(),
      });
      return {
        ...operation,
        id,
        custodyWalletId: input.custodyWalletId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        operationFamily: input.operationFamily,
        operationType: input.operationType,
        asset: input.asset ?? null,
        amount: input.amount ?? null,
        status: input.status ?? "created",
      };
    },
    async loadEffectivePolicies() {
      return { walletPolicy: effectiveWalletPolicy, apiKeyPolicy: null };
    },
    async loadVelocityObservations(candidate: VelocityCandidate, rules: VelocityPolicyRule[]) {
      const observations: VelocityObservation[] = [];
      for (const rule of rules) {
        for (const key of velocityObservationKeys(rule)) {
          const windowMs = parseIsoDurationMs(key.window);
          if (windowMs === null) {
            continue;
          }
          const since = now() - windowMs;
          let total = "0";
          for (const row of ledger) {
            const inScope =
              key.scope === "organization"
                ? row.organizationId === candidate.organizationId
                : key.scope === "api_key"
                  ? row.apiKeyId === candidate.apiKeyId
                  : row.custodyWalletId === candidate.custodyWalletId;
            if (
              !inScope ||
              row.id === candidate.id ||
              row.asset !== key.asset ||
              row.amount === null ||
              row.createdAt < since ||
              row.status === "failed" ||
              row.status === "canceled" ||
              (key.operationTypes !== null && !key.operationTypes.includes(row.operationType))
            ) {
              continue;
            }
            total = addDecimalAmounts(total, row.amount);
          }
          observations.push({ ...key, total });
        }
      }
      return observations;
    },
    async createApprovalRequest() {
      return { id: "apr_1", status: "pending" as const };
    },
    async recordPolicyEvaluation(input: RecordPolicyEvaluationInput) {
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
      const row = ledger.find((entry) => entry.id === walletOperationId);
      if (row !== undefined) {
        row.status = status;
      }
      return { status, updatedAt: "2026-06-18T00:00:01.000Z" };
    },
    async failApprovalRequest() {},
  };

  return { store, ledger };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const depositInput = (amount: string): CreateWalletOperationInput => ({
  organizationId: operation.organizationId,
  projectId: operation.projectId,
  custodyWalletId: operation.custodyWalletId,
  walletId: operation.walletId,
  apiKeyId: operation.apiKeyId,
  operationFamily: "program",
  operationType: "earn_vault_deposit",
  asset: "USDC",
  amount,
  legs: [],
});

describe("enforceWalletOperationPolicy velocity", () => {
  const policy = walletPolicy([
    { kind: "velocity", scope: "organization", window: "P1D", max: "100000", asset: "USDC" },
  ]);

  it("allows the deposit under the 24h cap and denies the one that crosses it", async () => {
    let clock = Date.UTC(2026, 5, 18, 0, 0, 0);
    const { store } = ledgerStore(policy, () => clock);

    const first = await enforceWalletOperationPolicy(store, depositInput("60000"));
    assert.equal(first.evaluation.decision, "allow");
    assert.equal(first.operation.status, "evaluated");

    clock += 60 * 60 * 1000;
    const second = await enforceWalletOperationPolicy(store, depositInput("50000"));
    assert.equal(second.evaluation.decision, "deny");
    assert.equal(second.operation.status, "failed");
    assert.match(second.evaluation.reason ?? "", /Window total 60000 plus operation amount 50000/);
  });

  it("forgets deposits that fell out of the window", async () => {
    let clock = Date.UTC(2026, 5, 18, 0, 0, 0);
    const { store } = ledgerStore(policy, () => clock);

    await enforceWalletOperationPolicy(store, depositInput("60000"));
    clock += DAY_MS + 1;
    const later = await enforceWalletOperationPolicy(store, depositInput("50000"));
    assert.equal(later.evaluation.decision, "allow");
  });

  it("does not count failed or canceled operations toward the window", async () => {
    const clock = Date.UTC(2026, 5, 18, 0, 0, 0);
    const { store, ledger } = ledgerStore(policy, () => clock);

    const denied = await enforceWalletOperationPolicy(store, depositInput("100001"));
    assert.equal(denied.evaluation.decision, "deny");
    assert.equal(ledger[0]?.status, "failed");
    ledger.push({ ...(ledger[0] as LedgerRow), id: "wop_canceled", status: "canceled" });

    const next = await enforceWalletOperationPolicy(store, depositInput("100000"));
    assert.equal(next.evaluation.decision, "allow");
  });

  it("yields approval_required on breach when the rule asks for it", async () => {
    const clock = Date.UTC(2026, 5, 18, 0, 0, 0);
    const { store } = ledgerStore(
      walletPolicy([
        {
          kind: "velocity",
          scope: "organization",
          window: "P1D",
          max: "100000",
          asset: "USDC",
          action: "approval_required",
        },
      ]),
      () => clock
    );

    await enforceWalletOperationPolicy(store, depositInput("60000"));
    const second = await enforceWalletOperationPolicy(store, depositInput("50000"));
    assert.equal(second.evaluation.decision, "approval_required");
    assert.equal(second.operation.status, "pending_approval");
    assert.equal(second.evaluation.approvalRequestId, "apr_1");
  });

  it("reviews when the store returns no observation for the rule", async () => {
    const { store, calls } = fakeStore(policy, {});

    const enforcement = await enforceWalletOperationPolicy(store, depositInput("1"));

    assert.equal(enforcement.evaluation.decision, "review");
    assert.match(enforcement.evaluation.reason ?? "", /Velocity window unavailable/);
    assert.ok(calls.some((call) => call.method === "loadVelocityObservations"));
  });

  it("skips the velocity port when no velocity rule is in play", async () => {
    const { store, calls } = fakeStore(walletPolicy([{ kind: "always", action: "allow" }]), {});

    await enforceWalletOperationPolicy(store, depositInput("1"));

    assert.ok(!calls.some((call) => call.method === "loadVelocityObservations"));
  });
});
