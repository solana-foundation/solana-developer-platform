import { isClusterFundableInEnvironment } from "@sdp/earn/support";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnStrategy } from "@sdp/types/earn";
import {
  type EarnProviderId,
  earnDepositSlippagePolicy,
  earnStrategyParticipation,
  earnWithdrawSlippageFloor,
  isEarnProviderSurfaced,
  SURFACED_EARN_PROVIDERS,
} from "@sdp/types/provider-access";
import type { EarnStrategyRow, ListEarnStrategiesInput } from "@/db/repositories/earn.repository";
import { isEarnHastraDexExitConfigured, isEarnVaultSponsorshipEnabled } from "@/lib/feature-flags";
import { type AppContext, getEarnRepository } from "@/routes/earn/context";
import type { Env } from "@/types/env";
import { CURATED_VAULTS, HIDDEN_STRATEGY_TERMS, HIDDEN_VAULTS } from "./handlers/curation";
import { pageWindow } from "./handlers/shared";

/**
 * Execution admission uses provider surfacing and reviewed source curation.
 * Discovery can list these strategies without granting deposit eligibility.
 */
function isHiddenStrategy(row: EarnStrategyRow): boolean {
  if (!isEarnProviderSurfaced(row.provider)) {
    return true;
  }

  const hidden = HIDDEN_VAULTS[row.host_cluster] ?? [];
  if (hidden.includes(`${row.provider}:${row.provider_reference}` as never)) {
    return true;
  }

  const curated = CURATED_VAULTS[row.host_cluster]?.[row.provider as EarnProviderId];
  if (curated !== undefined && !curated.includes(row.provider_reference)) {
    return true;
  }

  const searchable = [row.provider_reference, row.name, row.underlying_source ?? ""]
    .join("\n")
    .toLowerCase();
  return HIDDEN_STRATEGY_TERMS.some((term) => searchable.includes(term));
}

/** The reviewed execution shelf, separate from the broader indexed catalogue. */
export function isEarnStrategyInExecutionShelf(row: EarnStrategyRow): boolean {
  return !isHiddenStrategy(row);
}

/**
 * Takes the caller's environment because `fundable` is derived per request, not
 * stored: the catalogue is platform-global and the same row answers differently
 * to a sandbox and a production caller. A mainnet-only provider's row is listed
 * in both and fundable in one — see `hostCluster` in @sdp/types.
 *
 * `feeSponsored` is derived the same way, from the deployment's sponsorship
 * gate: the flag plus the cluster allowlist `resolveVaultSponsorship` reads at
 * execution, answered for the row's own cluster. A row that is not fundable is
 * never sponsored (there is no movement to sponsor), so the two agree.
 *
 * `depositSlippage` is derived per request too: every production deposit
 * carries a share floor, so the field answers for the caller's environment and
 * the row's own cluster exactly as the deposit routes gate
 * (`earnDepositSlippagePolicy`). A row that reads null never meets a build that
 * demands `minSharesOut` — including a devnet Kamino row, whose program cannot
 * enforce one, and an asynchronous next-NAV provider whose on-chain leg
 * deliberately cannot.
 */
export function mapToEarnStrategy(
  row: EarnStrategyRow,
  environment: SdpEnvironment,
  env: Pick<
    Env,
    "EARN_HASTRA_DEX_EXIT_ENABLED" | "EARN_VAULT_FEE_SPONSORSHIP_ENABLED" | "JUPITER_SWAP_API_KEY"
  >
): EarnStrategy {
  const depositSlippage = earnDepositSlippagePolicy(row.provider, environment, row.host_cluster);
  const withdrawalSlippage =
    row.provider === "hastra" && !isEarnHastraDexExitConfigured(env)
      ? null
      : earnWithdrawSlippageFloor(row.provider);
  const fundable = isClusterFundableInEnvironment(row.host_cluster, environment);
  return {
    ...earnStrategyParticipation(row.provider, row.risk_metadata.participation),
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
    depositSlippage: depositSlippage
      ? { quoteRequired: true, defaultToleranceBps: depositSlippage.defaultToleranceBps }
      : null,
    withdrawalSlippage: withdrawalSlippage
      ? { quoteRequired: true, defaultToleranceBps: withdrawalSlippage.defaultToleranceBps }
      : null,
    hostCluster: row.host_cluster,
    fundable,
    feeSponsored: fundable && isEarnVaultSponsorshipEnabled(env, row.host_cluster),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shared catalogue filters; only the core read can include discovery-only rows. */
export async function readEarnStrategyPage(
  c: AppContext,
  query: {
    page: number;
    pageSize: number;
    cluster?: ListEarnStrategiesInput["hostCluster"];
  } & Pick<
    ListEarnStrategiesInput,
    | "id"
    | "provider"
    | "depositMint"
    | "minApy"
    | "maxApy"
    | "sourceKind"
    | "apyType"
    | "liquidityTerm"
  >,
  options: { includeCatalogueOnly?: boolean } = {}
) {
  const repo = getEarnRepository(c);
  const { environment, cluster: projectCluster } = currentClusterScope();
  // The shelf a caller can act on is the default; `?cluster=` is the explicit
  // opt-in that browses another cluster's sub-shelf — in practice a sandbox
  // reader reviewing the mirrored mainnet catalogue (PRO-1742). Opting in
  // changes what is LISTED, never what can take a deposit: a foreign-cluster
  // row still arrives `fundable: false` and every provider mutation re-asserts
  // the same predicate.
  const cluster = query.cluster ?? projectCluster;
  const { rows, total } = await repo.listStrategies({
    environment,
    hostCluster: cluster,
    sourceKind: query.sourceKind,
    apyType: query.apyType,
    liquidityTerm: query.liquidityTerm,
    id: query.id,
    provider: query.provider,
    depositMint: query.depositMint,
    minApy: query.minApy,
    maxApy: query.maxApy,
    // Catalogue-only rows bypass execution-shelf filters. Admission checks
    // that shelf separately before allowing a new deposit.
    providers: SURFACED_EARN_PROVIDERS,
    excludeProviderKeys: options.includeCatalogueOnly ? undefined : (HIDDEN_VAULTS[cluster] ?? []),
    allowedProviderReferences: options.includeCatalogueOnly
      ? undefined
      : (CURATED_VAULTS[cluster] ?? {}),
    excludeRelatedTerms: options.includeCatalogueOnly ? undefined : HIDDEN_STRATEGY_TERMS,
    ...pageWindow(query),
  });
  return { rows, total, environment };
}
