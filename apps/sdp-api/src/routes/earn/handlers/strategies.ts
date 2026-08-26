import { isClusterFundableInEnvironment } from "@sdp/earn";
import {
  type EarnProviderId,
  type EarnStrategy,
  type EarnStrategyResponse,
  isEarnProviderSurfaced,
  type ListEarnStrategiesResponse,
  type SdpEnvironment,
  SURFACED_EARN_PROVIDERS,
} from "@sdp/types";
import type { EarnStrategyRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnStrategyIdParamsSchema, listEarnStrategiesQuerySchema } from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

/**
 * Indexed for catalogue completeness, intentionally absent from every public
 * strategy read. Keep the terms here at the API policy boundary rather than in
 * Ground's client or the sync, so the DB continues to reflect what Ground
 * reports and pagination can exclude the rows before applying its window.
 *
 * Note this is a different question from `fundable` below, and the two must
 * stay separate: this hides rows SDP has decided not to SHOW, while `fundable`
 * states whether an instrument the caller CAN see exists on their cluster. A
 * hidden row is absent; an un-fundable row is present and honest about itself.
 */
const HIDDEN_STRATEGY_TERMS = ["aave", "morpho"] as const;

/**
 * ── CATALOGUE CURATION, PER ENVIRONMENT ─────────────────────────────────────
 * The knob for a more opinionated shelf. Edit the lists below; nothing else
 * needs to change, and both take effect on the next request (no sync, no
 * migration, no cache to bust).
 *
 * **Keyed by environment, and that is not tidiness — a flat list is a trap.**
 * A vault is identified by its ADDRESS, and addresses are cluster-specific:
 * Kamino's mainnet shelf and its devnet shelf share no references at all. A
 * single `CURATED_VAULTS.kamino` holding mainnet addresses would therefore act
 * as an allowlist that matches NOTHING in sandbox and blank the entire devnet
 * shelf — a curation choice about production silently deleting sandbox.
 * Splitting by environment makes that impossible to express by accident.
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
const HIDDEN_VAULTS: Partial<Record<SdpEnvironment, readonly `${EarnProviderId}:${string}`[]>> = {
  production: [
    // "kamino:8F2mL9wLbYcQ1t2WcTgAsD5nDgQ1XjqK8kY7z4Q9example",
  ],
  sandbox: [
    // "kamino:7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  ],
};

const CURATED_VAULTS: Partial<
  Record<SdpEnvironment, Partial<Record<EarnProviderId, readonly string[]>>>
> = {
  production: {
    // kamino: ["<mainnet vault address>"],
  },
  sandbox: {
    // kamino: ["<devnet vault address>"],
  },
};

/**
 * Rows absent from every public strategy read, for either of TWO independent
 * reasons — kept in one predicate so the detail route can never drift from the
 * list route's filters:
 *
 * 1. The row's PROVIDER is not currently offered (`EARN_PROVIDER_SURFACING` in
 *    @sdp/types). Platform-level: we are not selling that provider today.
 * 2. The row names a SOURCE we have decided not to show. Editorial, per-row.
 *
 * Both are visibility, and neither is entitlement or `fundable`. Note the
 * asymmetry with the money routes this deliberately does not reach: an existing
 * program may point at a row hidden by either rule, and `assertKnownYieldSources`
 * still accepts it from the stored catalogue precisely because hiding a
 * customer's own position would hide their money.
 */
export function isHiddenStrategy(row: EarnStrategyRow): boolean {
  if (!isEarnProviderSurfaced(row.provider)) {
    return true;
  }

  const environment = row.environment as SdpEnvironment;
  const hidden = HIDDEN_VAULTS[environment] ?? [];
  if (hidden.includes(`${row.provider}:${row.provider_reference}` as never)) {
    return true;
  }

  const curated = CURATED_VAULTS[environment]?.[row.provider as EarnProviderId];
  if (curated !== undefined && !curated.includes(row.provider_reference)) {
    return true;
  }

  const searchable = [row.provider_reference, row.name, row.underlying_source ?? ""]
    .join("\n")
    .toLowerCase();
  return HIDDEN_STRATEGY_TERMS.some((term) => searchable.includes(term));
}

/**
 * Takes the caller's environment because `fundable` is derived per request, not
 * stored: the catalogue is platform-global and the same row answers differently
 * to a sandbox and a production caller. A mainnet-only provider's row is listed
 * in both and fundable in one — see `hostCluster` in @sdp/types.
 */
export function mapToEarnStrategy(row: EarnStrategyRow, environment: SdpEnvironment): EarnStrategy {
  return {
    id: row.id,
    provider: row.provider,
    providerReference: row.provider_reference,
    name: row.name,
    sourceKind: row.source_kind,
    underlyingSource: row.underlying_source ?? undefined,
    depositMints: row.deposit_mints,
    shareMint: row.share_mint ?? undefined,
    apyType: row.apy_type,
    currentApy: row.current_apy ?? undefined,
    liquidityTerm: row.liquidity_term,
    redemptionDelayDays: row.redemption_delay_days ?? undefined,
    riskMetadata: row.risk_metadata,
    status: row.status,
    hostCluster: row.host_cluster,
    fundable: isClusterFundableInEnvironment(row.host_cluster, environment),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Loads a strategy and applies the same environment and visibility policy as
 * the list route. The catalogue is platform-global, so environment scoping
 * happens here rather than via project scoping.
 */
export async function requireEarnStrategy(
  c: AppContext,
  strategyId: string
): Promise<EarnStrategyRow> {
  const repo = getEarnRepository(c);
  const strategy = await repo.getStrategyById(strategyId);

  if (
    !strategy ||
    strategy.environment !== resolveSdpEnvironment(c) ||
    isHiddenStrategy(strategy)
  ) {
    throw notFound("Earn strategy");
  }

  return strategy;
}

export const listEarnStrategies = async (c: AppContext) => {
  const query = parseQuery(c, listEarnStrategiesQuerySchema);

  const repo = getEarnRepository(c);
  const environment = resolveSdpEnvironment(c);
  const { rows, total } = await repo.listStrategies({
    environment,
    sourceKind: query.sourceKind,
    apyType: query.apyType,
    liquidityTerm: query.liquidityTerm,
    // Both visibility rules run in SQL so `total` and the page window describe
    // the rows the caller can see. `isHiddenStrategy` applies the same two rules
    // to the detail route, which has no query to push them into.
    providers: SURFACED_EARN_PROVIDERS,
    excludeProviderKeys: HIDDEN_VAULTS[environment] ?? [],
    allowedProviderReferences: CURATED_VAULTS[environment] ?? {},
    excludeRelatedTerms: HIDDEN_STRATEGY_TERMS,
    ...pageWindow(query),
  });

  const response: ListEarnStrategiesResponse = listResponse(query, total, {
    strategies: rows.map((row) => mapToEarnStrategy(row, environment)),
  });

  return success(c, response);
};

export const getEarnStrategy = async (c: AppContext) => {
  const { strategyId } = parseParams(c, earnStrategyIdParamsSchema);

  const strategy = await requireEarnStrategy(c, strategyId);

  const response: EarnStrategyResponse = {
    strategy: mapToEarnStrategy(strategy, resolveSdpEnvironment(c)),
  };
  return success(c, response);
};
