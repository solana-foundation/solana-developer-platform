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
 * Per-transaction transfer caps keyed by asset mint. Singular and plural asset
 * fields contribute together, while the first maximum for a repeated mint wins.
 *
 * @param rules - Policy rules to inspect.
 * @returns The deduplicated asset maximums in policy order.
 */
export function resolveTransferCaps(rules: PolicyRule[]): { asset: string; max: string }[] {
  const caps: { asset: string; max: string }[] = [];
  const seenAssets = new Set<string>();

  for (const rule of rules) {
    if (rule.kind !== "amount" || rule.max === undefined) continue;
    const assets: string[] = [];
    if (rule.asset !== undefined) assets.push(rule.asset);
    if (rule.assets !== undefined) assets.push(...rule.assets);

    for (const asset of assets) {
      if (seenAssets.has(asset)) continue;
      caps.push({ asset, max: rule.max });
      seenAssets.add(asset);
    }
  }

  return caps;
}
