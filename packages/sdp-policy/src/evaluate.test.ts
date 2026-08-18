import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WalletOperationFamily, WalletOperationType } from "@sdp/types";
import { createPolicyEvaluationInput } from "./enforce";
import {
  describeCandidateRuleCriteria,
  evaluateWalletOperationPolicies,
  IMPLICIT_DEFAULT_ALLOW_POLICY,
} from "./evaluate";
import { apiKeyPolicy, leg, operation, walletPolicy } from "./test-support";

const representativeFamilies: Array<[WalletOperationFamily, WalletOperationType]> = [
  ["transfer", "payment_transfer_execute"],
  ["payment", "recurring_payment_create"],
  ["ramp", "ramp_onramp_quote"],
  ["issuance", "issuance_mint_execute"],
];

describe("evaluateWalletOperationPolicies", () => {
  it("preserves implicit default allow when no active policies exist", () => {
    const result = evaluateWalletOperationPolicies({
      operation: { ...operation, apiKeyId: null },
      legs: [],
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
      legs: [],
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
        legs: [],
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
      legs: [],
      walletPolicy: usdcPolicy,
      apiKeyPolicy: null,
    });
    const skipped = evaluateWalletOperationPolicies({
      operation: { ...operation, asset: "SOL" },
      legs: [],
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
        operationFamily: "issuance",
        operationType: "issuance_update_authority_execute",
        amount: null,
      },
      legs: [],
      walletPolicy: walletPolicy([{ kind: "amount", asset: "USDC", max: "100" }]),
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
      legs: [],
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
      legs: [],
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
      legs: [],
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
      legs: [],
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
      legs: [],
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
      legs: [],
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
      legs: [],
      walletPolicy: walletPolicy([{ kind: "amount", asset: "USDC", max: "not-a-decimal" }]),
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

  it("denies a multi-leg operation when a destination rule rejects one leg", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      legs: [leg({ destination: "recipient_allowed" }), leg({ destination: "recipient_blocked" })],
      walletPolicy: walletPolicy([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    assert.match(
      result.wallet.reason,
      /^Leg 2: Destination recipient_blocked is not allowed by policy\./
    );
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "destinations", kind: "destination", decision: "allow", leg: 0 },
      { scope: "wallet", ruleId: "destinations", kind: "destination", decision: "deny", leg: 1 },
    ]);
  });

  it("allows a multi-leg operation when every leg satisfies the destination allowlist", () => {
    const result = evaluateWalletOperationPolicies({
      operation: { ...operation, destination: null },
      legs: [
        leg({ destination: "recipient_allowed" }),
        leg({ destination: "recipient_allowed_2" }),
      ],
      walletPolicy: walletPolicy([
        {
          id: "destinations",
          kind: "destination",
          allowlist: ["recipient_allowed", "recipient_allowed_2"],
        },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "allow",
      reasonCode: "wallet_policy_match",
      requiresApproval: false,
    });
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "destinations", decision: "allow", leg: 0 },
      { scope: "wallet", ruleId: "destinations", decision: "allow", leg: 1 },
    ]);
  });

  it("denies on the aggregate view when the total exceeds an amount maximum", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      legs: [leg({ amount: "60" }), leg({ amount: "65.50" })],
      walletPolicy: walletPolicy([{ id: "cap", kind: "amount", asset: "USDC", max: "100" }]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    assert.match(result.wallet.reason, /^Operation amount 125\.50 exceeds policy maximum 100\./);
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "cap", decision: "deny", leg: null },
      { scope: "wallet", ruleId: "cap", decision: "allow", leg: 0 },
      { scope: "wallet", ruleId: "cap", decision: "allow", leg: 1 },
    ]);
  });

  it("denies with a leg prefix when only one leg violates an amount bound", () => {
    const result = evaluateWalletOperationPolicies({
      operation,
      legs: [leg({ amount: "120" }), leg({ amount: "5.50" })],
      walletPolicy: walletPolicy([
        { id: "bounds", kind: "amount", asset: "USDC", min: "10", max: "200" },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    assert.match(
      result.wallet.reason,
      /^Leg 2: Operation amount 5\.50 is below policy minimum 10\./
    );
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "bounds", decision: "allow", leg: null },
      { scope: "wallet", ruleId: "bounds", decision: "allow", leg: 0 },
      { scope: "wallet", ruleId: "bounds", decision: "deny", leg: 1 },
    ]);
  });

  it("fails closed on a missing destination when the operation has no legs", () => {
    const result = evaluateWalletOperationPolicies({
      operation: { ...operation, destination: null },
      legs: [],
      walletPolicy: walletPolicy([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]),
      apiKeyPolicy: null,
    });

    assert.partialDeepStrictEqual(result, {
      decision: "deny",
      reasonCode: "wallet_policy_match",
    });
    assert.match(
      result.wallet.reason,
      /^Operation has no destination for destination policy evaluation\./
    );
    assert.partialDeepStrictEqual(result.matchedRules, [
      { scope: "wallet", ruleId: "destinations", kind: "destination", decision: "deny", leg: null },
    ]);
  });
});

describe("describeCandidateRuleCriteria", () => {
  it("describes every rule per view and omits destination rules from the aggregate", () => {
    const criteria = describeCandidateRuleCriteria(
      "wallet",
      walletPolicy([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
        { id: "cap", kind: "amount", asset: "USDC", max: "100" },
      ]),
      operation,
      [leg({ destination: "recipient_allowed", amount: "60" }), leg({ amount: "65.50" })]
    );

    assert.equal(criteria.length, 5);
    assert.partialDeepStrictEqual(criteria, [
      { ruleId: "cap", kind: "amount", matched: true, action: "deny", leg: null },
      { ruleId: "destinations", kind: "destination", matched: true, action: "allow", leg: 0 },
      { ruleId: "cap", kind: "amount", matched: true, action: "allow", leg: 0 },
      { ruleId: "destinations", kind: "destination", matched: true, action: "deny", leg: 1 },
      { ruleId: "cap", kind: "amount", matched: true, action: "allow", leg: 1 },
    ]);
  });

  it("returns no criteria for a scope without an active revision", () => {
    const criteria = describeCandidateRuleCriteria(
      "wallet",
      IMPLICIT_DEFAULT_ALLOW_POLICY,
      operation,
      []
    );

    assert.deepEqual(criteria, []);
  });
});
