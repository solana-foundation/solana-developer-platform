import type {
  ApiKeyControlProfile,
  ApiKeyControlProfileRevision,
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  PolicyDefaultAction,
  PolicyRule,
  WalletControlProfile,
  WalletControlProfileRevision,
  WalletOperationEnvelope,
  WalletOperationFamily,
} from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { CreatePolicyEvaluationInput, PolicyRepository } from "@/db/repositories";
import {
  createPolicyEvaluationInput,
  evaluateWalletOperationPolicies,
} from "./policy-evaluation.service";
import { PolicyFoundationService } from "./policy-foundation.service";

const operation: WalletOperationEnvelope = {
  id: "wop_1",
  organizationId: "org_1",
  projectId: "prj_1",
  custodyWalletId: "cw_1",
  walletId: "wal_1",
  apiKeyId: "key_1",
  actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
  source: "api",
  operationFamily: "payment",
  operationType: "payment_request",
  asset: "USDC",
  amount: "125.50",
  destination: "recipient_blocked",
  context: { requestId: "req_1" },
  providerExtensions: { provider: "future-provider" },
  rawPayload: { paymentRequestId: "payreq_1" },
  idempotencyKey: "idem_1",
  status: "created",
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

const representativeFamilies: Array<[WalletOperationFamily, string]> = [
  ["transfer", "token_transfer"],
  ["payment", "payment_request"],
  ["ramp", "ramp_transfer"],
  ["issuance", "issuance_admin"],
  ["raw_sign", "sign_message"],
  ["program", "program_call"],
  ["provider_admin", "provider_policy_update"],
];

function walletPolicy(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): EffectiveWalletPolicy {
  const profile: WalletControlProfile = {
    id: "wcp_1",
    organizationId: "org_1",
    projectId: "prj_1",
    custodyWalletId: "cw_1",
    name: "Wallet controls",
    status: "active",
    activeRevisionId: "wcpr_1",
    createdBy: "usr_1",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    activatedAt: "2026-06-18T00:00:00.000Z",
    archivedAt: null,
  };
  const revision: WalletControlProfileRevision = {
    id: "wcpr_1",
    profileId: profile.id,
    revisionNumber: 1,
    rules,
    defaultAction,
    createdBy: "usr_1",
    createdAt: "2026-06-18T00:00:00.000Z",
    activatedAt: "2026-06-18T00:00:00.000Z",
  };
  return {
    source: "customer_profile",
    profile,
    revision,
    defaultAction,
  };
}

function apiKeyPolicy(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): EffectiveApiKeyPolicy {
  const profile: ApiKeyControlProfile = {
    id: "akcp_1",
    organizationId: "org_1",
    projectId: "prj_1",
    apiKeyId: "key_1",
    name: "API key controls",
    status: "active",
    activeRevisionId: "akcpr_1",
    createdBy: "usr_1",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    activatedAt: "2026-06-18T00:00:00.000Z",
    archivedAt: null,
  };
  const revision: ApiKeyControlProfileRevision = {
    id: "akcpr_1",
    profileId: profile.id,
    revisionNumber: 1,
    rules,
    defaultAction,
    createdBy: "usr_1",
    createdAt: "2026-06-18T00:00:00.000Z",
    activatedAt: "2026-06-18T00:00:00.000Z",
  };
  return {
    source: "customer_profile",
    profile,
    revision,
    defaultAction,
  };
}

function implicitWalletPolicy(): EffectiveWalletPolicy {
  return {
    source: "implicit_default_allow",
    profile: null,
    revision: null,
    defaultAction: "allow",
  };
}

describe("evaluateWalletOperationPolicies", () => {
  it("preserves implicit default allow when no active policies exist", () => {
    const result = evaluateWalletOperationPolicies({
      operation: { ...operation, apiKeyId: null },
      walletPolicy: implicitWalletPolicy(),
    });

    expect(result).toMatchObject({
      decision: "allow",
      reasonCode: "implicit_default_allow",
      requiresApproval: false,
      walletPolicyRevisionId: null,
      apiKeyPolicyRevisionId: null,
    });
    expect(result.matchedRules).toEqual([]);
    expect(createPolicyEvaluationInput(result)).toMatchObject({
      walletOperationId: operation.id,
      decision: "allow",
      reasonCode: "implicit_default_allow",
      matchedRules: [],
      evaluationContext: expect.objectContaining({
        operation: expect.objectContaining({
          actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
          context: { requestId: "req_1" },
          providerExtensions: { provider: "future-provider" },
          rawPayload: { paymentRequestId: "payreq_1" },
        }),
      }),
    });
  });

  it.each(
    representativeFamilies
  )("evaluates a representative %s wallet operation envelope", (operationFamily, operationType) => {
    const familyOperation = {
      ...operation,
      operationFamily,
      operationType,
      rawPayload: {
        provider: "future-provider",
        providerExtensions: { opaqueField: "preserved" },
      },
      providerExtensions: { provider: "future-provider", opaqueField: "preserved" },
    };
    const result = evaluateWalletOperationPolicies({
      operation: familyOperation,
      walletPolicy: walletPolicy(
        [{ id: `${operationFamily}-allow`, kind: "operation_family", families: [operationFamily] }],
        "deny"
      ),
    });

    expect(result).toMatchObject({
      decision: "allow",
      reasonCode: "wallet_policy_match",
      walletPolicyRevisionId: "wcpr_1",
    });
    expect(result.evaluationContext.operation.rawPayload).toEqual(familyOperation.rawPayload);
    expect(result.evaluationContext.operation.providerExtensions).toEqual(
      familyOperation.providerExtensions
    );
    expect(result.matchedRules).toEqual([
      expect.objectContaining({
        scope: "wallet",
        ruleId: `${operationFamily}-allow`,
        kind: "operation_family",
        decision: "allow",
      }),
    ]);
  });

  it("denies destinations outside an active destination allowlist", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]),
    });

    expect(result.decision).toBe("deny");
    expect(result.reasonCode).toBe("wallet_policy_match");
    expect(result.walletPolicyRevisionId).toBe("wcpr_1");
    expect(result.matchedRules).toEqual([
      expect.objectContaining({
        scope: "wallet",
        ruleId: "destinations",
        kind: "destination",
        decision: "deny",
      }),
    ]);
    expect(result.apiKey).toMatchObject({
      source: "implicit_default_allow",
      decision: "allow",
      matchedRules: [],
    });
  });

  it("evaluates amount constraints only for matching assets", () => {
    const usdcPolicy = walletPolicy([{ kind: "amount", asset: "USDC", max: "100" }]);
    const denied = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: usdcPolicy,
    });
    const skipped = evaluateWalletOperationPolicies({
      operation: { ...operation, asset: "SOL" },
      walletPolicy: usdcPolicy,
    });

    expect(denied).toMatchObject({
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    expect(denied.reason).toContain("exceeds policy maximum 100");
    expect(skipped).toMatchObject({
      decision: "allow",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    expect(skipped.wallet.matchedRules).toEqual([]);
  });

  it("skips amount constraints for operations that carry no amount", () => {
    const result = evaluateWalletOperationPolicies({
      operation: {
        ...operation,
        operationFamily: "program",
        operationType: "program_call",
        amount: null,
      },
      walletPolicy: walletPolicy([{ kind: "amount", max: "100" }]),
    });

    expect(result).toMatchObject({
      decision: "allow",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    expect(result.wallet.reason).toContain("default action allow applies");
  });

  it("reviews empty amount bounds instead of treating them as absent", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "amount", min: "" }]),
    });

    expect(result).toMatchObject({
      decision: "review",
      reasonCode: "wallet_policy_match",
    });
    expect(result.matchedRules[0]).toEqual(
      expect.objectContaining({
        kind: "amount",
        decision: "review",
        reason: "Amount rule has an invalid decimal bound.",
      })
    );
  });

  it("requires approval when an approval rule matches", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        { id: "payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });

    expect(result).toMatchObject({
      decision: "approval_required",
      requiresApproval: true,
      walletPolicyRevisionId: "wcpr_1",
    });
    expect(createPolicyEvaluationInput(result)).toMatchObject({
      decision: "approval_required",
      requiresApproval: true,
    });
  });

  it("represents provider approval separately from SDP approval", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        {
          id: "provider-approval",
          kind: "approval",
          families: ["payment"],
          action: "provider_approval_required",
        },
      ]),
    });

    expect(result).toMatchObject({
      decision: "provider_approval_required",
      requiresApproval: true,
      reasonCode: "wallet_policy_match",
    });
    expect(result.matchedRules[0]).toEqual(
      expect.objectContaining({
        ruleId: "provider-approval",
        decision: "provider_approval_required",
      })
    );
  });

  it("does not apply predicate rule actions when the predicate does not match", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy(
        [{ id: "issuance-only", kind: "operation_family", families: ["issuance"], action: "deny" }],
        "allow"
      ),
    });

    expect(result).toMatchObject({
      decision: "allow",
      matchedRules: [],
    });
    expect(result.wallet.reason).toContain("default action allow applies");
  });

  it("lets the strictest wallet or API key policy decision win", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "approval", families: ["payment"] }]),
      apiKeyPolicy: apiKeyPolicy([
        {
          id: "api-key-blocked-destination",
          kind: "destination",
          blocklist: ["recipient_blocked"],
        },
      ]),
    });

    expect(result).toMatchObject({
      decision: "deny",
      reasonCode: "api_key_policy_match",
      requiresApproval: false,
      walletPolicyRevisionId: "wcpr_1",
      apiKeyPolicyRevisionId: "akcpr_1",
    });
    expect(result.matchedRules).toEqual([
      expect.objectContaining({ scope: "wallet", decision: "approval_required" }),
      expect.objectContaining({ scope: "api_key", decision: "deny" }),
    ]);
  });

  it("preserves SDP approval when it ties with provider approval", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        {
          id: "provider-approval",
          kind: "approval",
          families: ["payment"],
          action: "provider_approval_required",
        },
      ]),
      apiKeyPolicy: apiKeyPolicy([
        {
          id: "api-key-sdp-approval",
          kind: "approval",
          families: ["payment"],
          action: "approval_required",
        },
      ]),
    });

    expect(result).toMatchObject({
      decision: "approval_required",
      reasonCode: "api_key_policy_match",
      requiresApproval: true,
    });
    expect(result.matchedRules).toEqual([
      expect.objectContaining({ scope: "wallet", decision: "provider_approval_required" }),
      expect.objectContaining({ scope: "api_key", decision: "approval_required" }),
    ]);
  });

  it("falls back to the revision default action when no rules match", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "approval", families: ["issuance"] }], "deny"),
    });

    expect(result).toMatchObject({
      decision: "deny",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    expect(result.wallet.reason).toContain("default action deny applies");
  });

  it("sends malformed active policy rules to review instead of silently allowing", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "amount", max: "not-a-decimal" }]),
    });

    expect(result).toMatchObject({
      decision: "review",
      reasonCode: "wallet_policy_match",
      requiresApproval: false,
    });
    expect(result.matchedRules[0]).toEqual(
      expect.objectContaining({
        scope: "wallet",
        kind: "amount",
        decision: "review",
      })
    );
  });
});

describe("PolicyFoundationService policy evaluation", () => {
  it("resolves active policies and records the evaluation payload", async () => {
    const createPolicyEvaluation = vi.fn(async (input: CreatePolicyEvaluationInput) => ({
      id: "peval_1",
      wallet_operation_id: input.walletOperationId,
      wallet_policy_revision_id: input.walletPolicyRevisionId ?? null,
      api_key_policy_revision_id: input.apiKeyPolicyRevisionId ?? null,
      decision: input.decision,
      reason_code: input.reasonCode,
      reason: input.reason ?? null,
      matched_rules: input.matchedRules ?? [],
      evaluation_context: input.evaluationContext,
      requires_approval: input.requiresApproval ?? false,
      approval_request_id: input.approvalRequestId ?? null,
      created_at: "2026-06-18T00:00:00.000Z",
    }));
    const repository = {
      getActiveWalletControlProfileByCustodyWalletId: vi.fn(async () => ({
        profile: {
          id: "wcp_1",
          organization_id: "org_1",
          project_id: "prj_1",
          custody_wallet_id: "cw_1",
          name: "Wallet controls",
          status: "active",
          active_revision_id: "wcpr_1",
          created_by: "usr_1",
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
          activated_at: "2026-06-18T00:00:00.000Z",
          archived_at: null,
        },
        revision: {
          id: "wcpr_1",
          profile_id: "wcp_1",
          revision_number: 1,
          rules: [{ kind: "destination", allowlist: ["recipient_allowed"] }],
          default_action: "allow",
          created_by: "usr_1",
          created_at: "2026-06-18T00:00:00.000Z",
          activated_at: "2026-06-18T00:00:00.000Z",
        },
      })),
      getActiveApiKeyControlProfileByApiKeyId: vi.fn(async () => null),
      createPolicyEvaluation,
    } as unknown as PolicyRepository;
    const service = new PolicyFoundationService(repository);

    const evaluation = await service.recordWalletOperationPolicyEvaluation(operation);

    expect(evaluation).toMatchObject({
      id: "peval_1",
      walletOperationId: operation.id,
      walletPolicyRevisionId: "wcpr_1",
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    expect(createPolicyEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        walletOperationId: operation.id,
        walletPolicyRevisionId: "wcpr_1",
        decision: "deny",
      })
    );
  });
});
