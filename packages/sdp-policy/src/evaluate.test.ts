import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WalletOperationFamily } from "@sdp/types";
import { createPolicyEvaluationInput } from "./enforce";
import { evaluateWalletOperationPolicies, IMPLICIT_DEFAULT_ALLOW_POLICY } from "./evaluate";
import { apiKeyPolicy, operation, walletPolicy } from "./test-support";

const representativeFamilies: Array<[WalletOperationFamily, string]> = [
  ["transfer", "token_transfer"],
  ["payment", "payment_request"],
  ["ramp", "ramp_transfer"],
  ["issuance", "issuance_admin"],
  ["raw_sign", "sign_message"],
  ["program", "program_call"],
  ["provider_admin", "provider_policy_update"],
];

describe("evaluateWalletOperationPolicies", () => {
  it("preserves implicit default allow when no active policies exist", () => {
    const result = evaluateWalletOperationPolicies({
      operation: { ...operation, apiKeyId: null },
      walletPolicy: IMPLICIT_DEFAULT_ALLOW_POLICY,
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "allow",
      reasonCode: "implicit_default_allow",
      requiresApproval: false,
      walletPolicyRevisionId: null,
      apiKeyPolicyRevisionId: null,
      matchedRules: [],
    });
    assert.equal(result.apiKey, null);
    assert.partialDeepStrictEqual(createPolicyEvaluationInput(result), {
      walletOperationId: operation.id,
      decision: "allow",
      reasonCode: "implicit_default_allow",
      matchedRules: [],
      evaluationContext: {
        operation: {
          actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
          context: { requestId: "req_1" },
          providerExtensions: { provider: "future-provider" },
          rawPayload: { paymentRequestId: "payreq_1" },
        },
      },
    });
  });

  it("evaluates the API-key scope as implicit allow when the operation used a key", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
      walletPolicyRevisionId: "wcpr_1",
    });
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "destinations", kind: "destination", decision: "deny" },
    ]);
    assert.partialDeepStrictEqual(result.apiKey, {
      source: "implicit_default_allow",
      decision: "allow",
      matchedRules: [],
    });
  });

  for (const [operationFamily, operationType] of representativeFamilies) {
    it(`evaluates a representative ${operationFamily} wallet operation envelope`, () => {
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
          [
            {
              id: `${operationFamily}-allow`,
              kind: "operation_family",
              families: [operationFamily],
            },
          ],
          "deny"
        ),
        apiKeyPolicy: null,
      });

      assert.partialDeepStrictEqual(result, {
        decision: "allow",
        reasonCode: "wallet_policy_match",
        walletPolicyRevisionId: "wcpr_1",
      });
      assert.deepEqual(result.evaluationContext.operation.rawPayload, familyOperation.rawPayload);
      assert.deepEqual(
        result.evaluationContext.operation.providerExtensions,
        familyOperation.providerExtensions
      );
      assert.partialDeepStrictEqual(result.matchedRules, [
        {
          scope: "wallet",
          ruleId: `${operationFamily}-allow`,
          kind: "operation_family",
          decision: "allow",
        },
      ]);
    });
  }

  it("evaluates amount constraints only for matching assets", () => {
    const usdcPolicy = walletPolicy([{ kind: "amount", asset: "USDC", max: "100" }]);
    const denied = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: usdcPolicy,
      apiKeyPolicy: null,
    });
    const skipped = evaluateWalletOperationPolicies({
      operation: { ...operation, asset: "SOL" },
      walletPolicy: usdcPolicy,
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(denied, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    assert.match(denied.reason, /exceeds policy maximum 100/);
    assert.partialDeepStrictEqual(skipped, {
      decision: "allow",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    assert.deepEqual(skipped.wallet.matchedRules, []);
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
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "allow",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    assert.match(result.wallet.reason, /default action allow applies/);
  });

  it("requires approval when an approval rule matches", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([
        { id: "payment-approval", kind: "approval", families: ["payment"] },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "approval_required",
      requiresApproval: true,
      walletPolicyRevisionId: "wcpr_1",
    });
    assert.partialDeepStrictEqual(createPolicyEvaluationInput(result), {
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
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "provider_approval_required",
      requiresApproval: true,
      reasonCode: "wallet_policy_match",
    });
    assert.partialDeepStrictEqual(result.matchedRules[0], {
      ruleId: "provider-approval",
      decision: "provider_approval_required",
    });
  });

  it("does not apply predicate rule actions when the predicate does not match", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy(
        [{ id: "issuance-only", kind: "operation_family", families: ["issuance"], action: "deny" }],
        "allow"
      ),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, { decision: "allow", matchedRules: [] });
    assert.match(result.wallet.reason, /default action allow applies/);
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

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "api_key_policy_match",
      requiresApproval: false,
      walletPolicyRevisionId: "wcpr_1",
      apiKeyPolicyRevisionId: "akcpr_1",
    });
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", decision: "approval_required" },
      { scope: "api_key", decision: "deny" },
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

    assert.partialDeepStrictEqual(result, {
      decision: "approval_required",
      reasonCode: "api_key_policy_match",
      requiresApproval: true,
    });
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", decision: "provider_approval_required" },
      { scope: "api_key", decision: "approval_required" },
    ]);
  });

  it("falls back to the revision default action when no rules match", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "approval", families: ["issuance"] }], "deny"),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
      matchedRules: [],
    });
    assert.match(result.wallet.reason, /default action deny applies/);
  });

  it("sends malformed active policy rules to review instead of silently allowing", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      walletPolicy: walletPolicy([{ kind: "amount", max: "not-a-decimal" }]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "review",
      reasonCode: "wallet_policy_match",
      requiresApproval: false,
    });
    assert.partialDeepStrictEqual(result.matchedRules[0], {
      scope: "wallet",
      kind: "amount",
      decision: "review",
    });
  });
});
