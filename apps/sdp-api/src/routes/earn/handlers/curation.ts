import type { EarnProviderId, SolanaCluster } from "@sdp/types";

/**
 * Per-vault catalogue curation config — the data behind the strategy routes'
 * visibility policy. Split from `strategies.ts` so route tests can mock THIS
 * module (the shipped shelf changes with BD decisions, and tests must not
 * depend on today's picks — the same rule `EARN_PROVIDER_SURFACING` follows);
 * the enforcement stays in `strategies.ts`, which is the only consumer.
 */

/**
 * Indexed for catalogue completeness, intentionally absent from every public
 * strategy read. Keep the terms here at the API policy boundary rather than in
 * Ground's client or the sync, so the DB continues to reflect what Ground
 * reports and pagination can exclude the rows before applying its window.
 *
 * Note this is a different question from `fundable`, and the two must
 * stay separate: this hides rows SDP has decided not to SHOW, while `fundable`
 * states whether an instrument the caller CAN see exists on their cluster. A
 * hidden row is absent; an un-fundable row is present and honest about itself.
 */
// "jupiter" excludes Jupiter Lend (BD, 2026-08-25: permissionless, no curator a
// client's compliance team can point at). A name term rather than the preferred
// `HIDDEN_VAULTS` address entry because no Jupiter Lend row exists on any
// provider registry today (verified against `GET /kvaults/vaults`, 2026-08-31),
// so there is no address to key on — and this list can exclusively REMOVE rows,
// which is what makes a name-based rule safe here.
export const HIDDEN_STRATEGY_TERMS = ["aave", "morpho", "jupiter"] as const;

/**
 * ── CATALOGUE CURATION, PER ENVIRONMENT ─────────────────────────────────────
 * The knob for a more opinionated shelf. Edit the lists below; nothing else
 * needs to change, and both take effect on the next request (no sync, no
 * migration, no cache to bust).
 *
 * **Keyed by CLUSTER, and that is not tidiness — a flat list is a trap.**
 * A vault is identified by its ADDRESS, and addresses are cluster-specific:
 * Kamino's mainnet shelf and its devnet shelf share no references at all. A
 * single `CURATED_VAULTS.kamino` holding mainnet addresses would therefore act
 * as an allowlist that matches NOTHING on devnet and blank the entire devnet
 * shelf — a curation choice about mainnet silently deleting the sandbox one.
 * Keying by the cluster the address lives on makes that impossible to express
 * by accident. (These were environment-keyed until PRO-1742. Now that a
 * non-production environment also carries the mirrored mainnet shelf, cluster
 * keying is also what makes the sandbox mirror inherit exactly the curation
 * production applies — the mirror exists to REVIEW that curation, so the two
 * views must never diverge.)
 *
 * **Always key on the vault ADDRESS, never the name.** Kamino's registry is
 * permissionless and the name is free text chosen by whoever created the vault,
 * so a name-keyed rule can be dodged by renaming and tripped by impersonating a
 * curated vault's name. `HIDDEN_STRATEGY_TERMS` above is name-based on purpose
 * and is safe only because it can exclusively REMOVE rows; the same trick
 * pointed the other way would be an admission hole. Mainnet addresses are in
 * `docs/earn/kamino-catalogue-inventory.md`; devnet ones come from the on-chain
 * read (`packages/sdp-earn/src/providers/kamino/devnet.ts`).
 *
 * Which to reach for:
 * - `HIDDEN_VAULTS` — subtractive. Drop a specific vault (dust, a duplicate, one
 *   we do not want to stand behind) while the rest of that environment's shelf
 *   keeps flowing in as the provider lists it. Start here.
 * - `CURATED_VAULTS` — a hand-picked shelf. An environment/provider pair listed
 *   here shows ONLY those vaults, so a newly created vault does NOT appear until
 *   someone adds it. Maximum editorial control, at the cost of a deploy per
 *   addition. An empty array means that provider shows nothing in that
 *   environment; an ABSENT key means no allowlist at all.
 *
 * Neither list touches what the sync STORES, so a curated-away vault stays in
 * `earn_strategies` and un-curating it is a deploy rather than an hour's wait.
 * Neither is an allocation gate either: `assertKnownYieldSources` reads the
 * stored catalogue, so an existing program pointed at a curated-away vault keeps
 * working — hiding a shelf is a browse decision, and freezing a customer's own
 * position over it would not be.
 */
export const HIDDEN_VAULTS: Partial<
  Record<SolanaCluster, readonly `${EarnProviderId}:${string}`[]>
> = {
  "mainnet-beta": [
    // "kamino:8F2mL9wLbYcQ1t2WcTgAsD5nDgQ1XjqK8kY7z4Q9example",
  ],
  devnet: [
    // "kamino:9K3nQ7rLbYcQ1t2WcTgAsD5nDgQ1XjqK8kY7z4Q9example",
  ],
};

/**
 * The V1 Kamino shelf (BD, 2026-08-25 — PRO-1727). Deliberately short so a
 * payments company is not wading through options: each pick is a recognizable
 * counterparty, weighted by payments-BD relationships and deposit size. Names,
 * tokens and AUM below are the 2026-08-31 census in
 * `docs/earn/kamino-catalogue-inventory.md`, regenerated from
 * `GET /kvaults/vaults`. Only the ADDRESSES are authoritative here: AUM moves
 * continuously (the 5-minute metrics refresh tracks it), so treat the figures
 * as the order-of-magnitude reason a vault was picked, not as state to reconcile
 * against. Curator attribution is kamino.com branding — the registry publishes
 * no curator field, which is also why these reasons live here and not in
 * `riskMetadata`.
 *
 * Near-name traps, so un-curating stays a decision rather than a guess: the
 * commodity vault has a same-named USDG twin at
 * `DM5ECR3UY28yFhnqvGu7RTducR9k9oVgYXJ7foB3PydK` (under $1 of AUM, dropped by
 * the TVL floor), and "Ethena Prime" (USDG) is NOT the Ethena pick.
 */
export const CURATED_VAULTS: Partial<
  Record<SolanaCluster, Partial<Record<EarnProviderId, readonly string[]>>>
> = {
  "mainnet-beta": {
    kamino: [
      // Ethena PYUSD Prime — Sentora-curated, PYUSD, $251M: the largest PYUSD
      // vault on the shelf and the anchor of the PYUSD lane.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf",
      // Sentora PYUSD — Sentora-curated, PYUSD, $109M: second PYUSD pick from
      // the same house, so the lane does not hang off one vault.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK",
      // Steakhouse High Yield USDG — Steakhouse-curated, USDG, $45M: the USDG
      // lane's pick from a house payments BD has a relationship with.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5",
      // Steakhouse USDC — Steakhouse-curated, USDC, $19M: the conservative
      // USDC pick from the same house.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E",
      // Steakhouse High Yield USDC — Steakhouse-curated, USDC, $3.6M: the
      // higher-yield USDC companion to the row above.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "BEEfo7xwgK2ZP13Pxo7qqTPzAteKJmXjVWtMWcXSvbn2",
      // Kamino Institutional Commodity Yield — Kamino-curated, USDC, $32M:
      // first-party Kamino pick. The USDC vault, NOT its $1-AUM USDG twin of
      // the same name (see the near-name traps above).
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6",
    ],
  },
  // Devnet equivalents for the sandbox shelf, read on-chain from the devnet
  // kvault program (`packages/sdp-earn/src/providers/kamino/devnet.ts`,
  // verified 2026-08-31). Devnet has no Sentora deployment and no USDG vaults,
  // so the picks mirror the production shelf's SHAPE — the recognizable-house
  // mirrors plus PYUSD coverage — rather than its exact rows.
  devnet: {
    kamino: [
      // Steakhouse USDC — devnet mirror of the production Steakhouse pick.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "7319GuA3DwpJV1SHKKbyLp9MZwiopfc9rUKqZqWJua7J",
      // Kamino Vault USDC — the first-party Kamino devnet vault.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "C7N2fqV2GvhFghDf5PJSwstyjedjLNCY1cm2Ak7TeU83",
      // PyUSDC — the one devnet vault denominated in real devnet PYUSD;
      // exercises the PYUSD deposit-token admission end to end in sandbox.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "EHW185wryv6BrQX2bmEyMTRN9GjxcqszU6DjeJuFhf11",
      // Allez USDC — recognizable-house devnet mirror.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
      // Gauntlet Frontier USDC — recognizable-house devnet mirror.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "26BUU5vos5HmET6fDhytZtbXQ3pNvGVbwnB29q3qr8uC",
      // RockawayX RWA USDC — recognizable-house devnet mirror.
      // biome-ignore lint/security/noSecrets: vault address constant, not a secret
      "CApPBBp8Fgb8zvRzDojfSe9bqzq6LejvDxFtucHoQaUk",
    ],
  },
};
