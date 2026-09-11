import type {
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  VelocityPolicyRule,
  VelocityPolicyRuleScope,
  WalletOperationType,
} from "@sdp/types";
import { ruleValues } from "./rules/helpers";

/** The scope a velocity rule sums when it names none. */
export const DEFAULT_VELOCITY_SCOPE: VelocityPolicyRuleScope = "wallet";

/**
 * The identity of one rolling-window total: everything a velocity rule's
 * query is keyed by, minus the candidate itself. One rule naming several
 * assets needs one observation per asset.
 */
export interface VelocityObservationKey {
  scope: VelocityPolicyRuleScope;
  window: string;
  asset: string;
  /** Sorted, de-duplicated; null when every operation type counts. */
  operationTypes: WalletOperationType[] | null;
}

/**
 * A rolling total the store measured for one key: the sum of prior
 * non-failed, non-canceled wallet-operation amounts inside the window,
 * excluding the operation under evaluation.
 */
export interface VelocityObservation extends VelocityObservationKey {
  /** Decimal string in the asset's units. */
  total: string;
}

/**
 * Synchronous lookup the evaluator consults for a rule's window total.
 * Evaluation stays pure: the store measures, this only answers.
 */
export interface PolicyEvaluationVelocity {
  lookup(key: VelocityObservationKey): VelocityObservation | null;
}

/**
 * The observation keys one velocity rule needs, one per asset it names.
 *
 * @param rule - The velocity rule.
 * @returns The keys; empty when the rule names no asset.
 */
export function velocityObservationKeys(rule: VelocityPolicyRule): VelocityObservationKey[] {
  const operationTypes =
    rule.operationTypes === undefined || rule.operationTypes.length === 0
      ? null
      : [...new Set(rule.operationTypes)].sort();
  return ruleValues(rule.asset, rule.assets).map((asset) => ({
    scope: rule.scope ?? DEFAULT_VELOCITY_SCOPE,
    window: rule.window,
    asset,
    operationTypes,
  }));
}

/**
 * Serialize an observation key so equal keys collide.
 *
 * @param key - The key to serialize.
 * @returns A stable string identity.
 */
export function serializeVelocityObservationKey(key: VelocityObservationKey): string {
  const operationTypes =
    key.operationTypes === null ? "*" : [...new Set(key.operationTypes)].sort().join(",");
  return `${key.scope}|${key.window}|${key.asset}|${operationTypes}`;
}

/**
 * Build the evaluator-side lookup over a store's observations.
 *
 * @param observations - The measured totals.
 * @returns The lookup; a key with no observation answers null.
 */
export function createVelocityLookup(
  observations: readonly VelocityObservation[]
): PolicyEvaluationVelocity {
  const byKey = new Map<string, VelocityObservation>();
  for (const observation of observations) {
    byKey.set(serializeVelocityObservationKey(observation), observation);
  }
  return {
    lookup(key) {
      return byKey.get(serializeVelocityObservationKey(key)) ?? null;
    },
  };
}

/**
 * Every velocity rule across both effective policies' active revisions, in
 * evaluation order. This is what the store measures before evaluation runs.
 *
 * @param policies - The effective wallet and API-key policies.
 * @returns The velocity rules; empty when neither revision holds one.
 */
export function collectVelocityRules(policies: {
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}): VelocityPolicyRule[] {
  const rules: VelocityPolicyRule[] = [];
  for (const policy of [policies.walletPolicy, policies.apiKeyPolicy]) {
    if (policy === null || policy.revision === null) {
      continue;
    }
    for (const rule of policy.revision.rules) {
      if (rule.kind === "velocity") {
        rules.push(rule);
      }
    }
  }
  return rules;
}
