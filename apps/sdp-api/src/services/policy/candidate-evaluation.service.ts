import { describeCandidateRuleCriteria, evaluateCandidatePolicies } from "@sdp/policy";
import type { PolicyCandidate, PolicyDryRunResult } from "@sdp/types";
import { createPolicyRepository } from "@/db/repositories";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";
import { PostgresPolicyEnforcementStore } from "./enforcement.store";

/**
 * The dry-run verdict for an operation that resolves no custody wallet: no
 * wallet policy governs it, so it is allowed with nothing to evaluate.
 */
export const UNGOVERNED_POLICY_DRY_RUN_RESULT: PolicyDryRunResult = {
  decision: "allow",
  reason: "The operation resolves no custody wallet, so no wallet policy governs it.",
  criteria: [],
  walletPolicyRevisionId: null,
  apiKeyPolicyRevisionId: null,
};

/**
 * Evaluate a candidate wallet operation against its effective policies
 * without persisting anything: no wallet-operation row, no approval request,
 * no evaluation audit row. Backs the Dry-Run exit of the policy gate, where
 * the handler never runs and the caller receives the verdict alone.
 *
 * @param env - The runtime environment.
 * @param scope - The trusted tenant scope of the request.
 * @param candidate - The candidate operation to evaluate.
 * @returns The verdict plus every rule in both scopes, matched or not.
 */
export async function dryRunPolicyCandidate(
  env: Env,
  scope: TenantScope,
  candidate: PolicyCandidate
): Promise<PolicyDryRunResult> {
  assertTenantClaim(scope, candidate, "dryRunPolicyCandidate");
  const store = new PostgresPolicyEnforcementStore(createPolicyRepository(env, scope), scope);
  const policies = await store.loadEffectivePolicies(candidate);
  const evaluation = evaluateCandidatePolicies({
    candidate,
    walletPolicy: policies.walletPolicy,
    apiKeyPolicy: policies.apiKeyPolicy,
  });

  return {
    decision: evaluation.decision,
    reason: evaluation.reason,
    criteria: [
      ...describeCandidateRuleCriteria("wallet", policies.walletPolicy, candidate),
      ...(policies.apiKeyPolicy === null
        ? []
        : describeCandidateRuleCriteria("api_key", policies.apiKeyPolicy, candidate)),
    ],
    walletPolicyRevisionId: evaluation.walletPolicyRevisionId,
    apiKeyPolicyRevisionId: evaluation.apiKeyPolicyRevisionId,
  };
}
