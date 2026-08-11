import type { PolicyRule } from "@sdp/types";

/**
 * Collects the effective destination allowlist across a set of policy rules,
 * mirroring the policy engine's union semantics for a "destination" rule
 * (`allowlist`, `destination`, and `destinations` all contribute).
 *
 * @param rules - Policy rules to inspect.
 * @returns Deduplicated allowlisted addresses across every destination rule.
 */
export function collectDestinationAllowlist(rules: PolicyRule[]): string[] {
  const addresses = rules.flatMap((rule) =>
    rule.kind === "destination"
      ? [
          ...(rule.destination ? [rule.destination] : []),
          ...(rule.destinations ?? []),
          ...(rule.allowlist ?? []),
        ]
      : []
  );
  return [...new Set(addresses)];
}

/**
 * The per-transaction transfer cap authored on the policy: the first "amount"
 * rule carrying a maximum. Amount rules are always keyed by asset mint, so the
 * cap bounds the assets its rule names.
 *
 * @param rules - Policy rules to inspect.
 * @returns The cap's maximum, or null when no cap is set.
 */
export function resolveMaxTransferAmount(rules: PolicyRule[]): string | null {
  const capRule = rules.find(
    (rule): rule is Extract<PolicyRule, { kind: "amount" }> =>
      rule.kind === "amount" && rule.max !== undefined
  );
  return capRule && capRule.max !== undefined ? capRule.max : null;
}
