import type { PolicyRule } from "@sdp/types";

/**
 * Collects the effective destination allowlist across a set of policy rules,
 * mirroring the policy engine's own union semantics for a "destination" rule
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
 * The wallet-wide transfer amount cap, drawn from an "amount" rule that names
 * no specific asset. Asset-scoped amount rules cap only the assets they name
 * and say nothing about a wallet-wide ceiling, so they are excluded here.
 *
 * @param rules - Policy rules to inspect.
 * @returns The cap's maximum, or null when no wallet-wide cap is set.
 */
export function resolveMaxTransferAmount(rules: PolicyRule[]): string | null {
  const capRule = rules.find(
    (rule): rule is Extract<PolicyRule, { kind: "amount" }> =>
      rule.kind === "amount" && !rule.asset && !rule.assets?.length && rule.max !== undefined
  );
  return capRule && capRule.max !== undefined ? capRule.max : null;
}
