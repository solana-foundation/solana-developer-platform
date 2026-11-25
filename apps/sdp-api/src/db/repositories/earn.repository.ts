import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
} from "@sdp/types/earn";
import type { EarnProviderId } from "@sdp/types/provider-access";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export function generateEarnStrategyId(): string {
  return `earn_strategy_${crypto.randomUUID()}`;
}

export interface EarnStrategyRow {
  id: string;
  /**
   * Open TEXT column (ADR 0002): a row can outlive its provider's registry
   * entry, so reads never narrow to EarnProviderId — all dispatch goes through
   * the fail-closed resolveEarnProviderClient. Writes stay closed (see
   * UpsertEarnStrategyInput).
   */
  provider: string;
  provider_reference: string;
  name: string;
  source_kind: EarnStrategySourceKind;
  underlying_source: string | null;
  deposit_mints: string[];
  share_mint: string | null;
  apy_type: EarnApyType;
  current_apy: string | null;
  /** Provider rate observation, independent of metadata updates. */
  rate_observed_at?: string | null;
  liquidity_term: EarnLiquidityTerm;
  redemption_delay_days: number | null;
  risk_metadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  /**
   * Set only when catalogue sync deprecated this row after a provider stopped
   * listing it. The row remains as an exit-safe metadata tombstone. A null
   * value means the status is provider- or operator-owned instead.
   */
  catalogue_delisted_at: string | null;
  /**
   * Cluster the instrument lives on — NOT implied by `environment`, which is
   * why it is a column. Since PRO-1742 a non-production environment holds BOTH
   * clusters on purpose: its own cluster's shelf plus a browse-only mirror of
   * the production mainnet shelf, so curation can be reviewed outside
   * production. `isClusterFundableInEnvironment` is what keeps the mirrored
   * rows un-depositable. See migration 0057.
   */
  host_cluster: SolanaCluster;
  environment: SdpEnvironment;
  created_at: string;
  updated_at: string;
}

/** Catalogue sync upsert, keyed on (provider, provider_reference, environment). */
export interface UpsertEarnStrategyInput {
  provider: EarnProviderId;
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource: string | null;
  depositMints: string[];
  shareMint: string | null;
  apyType: EarnApyType;
  currentApy: string | null;
  /** When this rate was fetched; omit for metadata-only writes. */
  rateObservedAt?: string | null;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays: number | null;
  riskMetadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  /** Cluster the instrument lives on; the provider states it, never the sync. */
  hostCluster: SolanaCluster;
  environment: SdpEnvironment;
}

/**
 * The volatile figures a short-cadence refresh may rewrite, and nothing else.
 * No name, no mints, no liquidity term, no status — narrowing the input is what
 * makes "a refresh cannot change what a strategy IS" a property of the type
 * rather than a convention.
 */
export interface UpdateEarnStrategyMetricsInput {
  provider: EarnProviderId;
  providerReference: string;
  environment: SdpEnvironment;
  /** Null clears a rate the provider no longer reports. */
  currentApy: string | null;
  /** When this rate was fetched, not when its database write completes. */
  rateObservedAt?: string | null;
  /** Merged over the stored metadata, so curator and friends survive. */
  riskMetadata: EarnStrategyRiskMetadata;
}

/**
 * Delist pass input: everything the provider still lists for (provider,
 * environment). Any other active row is stale, either a vault the provider
 * delisted or one a tightened catalogue gate now refuses, and becomes a
 * deprecated metadata tombstone, so its stable id keeps resolving.
 *
 * `listedProviderReferences` is the KEEP set, never the delist set, so the
 * caller cannot enumerate stale rows it does not know about: the provider's
 * live list is the only input, and the DB decides what that leaves behind.
 */
export interface DeprecateUnlistedEarnStrategiesInput {
  provider: EarnProviderId;
  environment: SdpEnvironment;
  /**
   * Scope the delist to one cluster's sub-shelf. A non-production environment
   * holds two independently-sourced shelves since PRO-1742 — its own cluster's
   * catalogue plus the mirrored mainnet one — and each fetch may only delist
   * the rows it is the truth for: an unscoped delist run with one lane's keep
   * set would deprecate the other lane's shelf. Omitted, the delist covers the
   * whole environment (production, where the provider's own fetch IS the total
   * truth and stray wrong-cluster rows should converge away). A NULL
   * `host_cluster` row counts as the environment's own cluster — the same rule
   * mapStrategyRow reads by.
   */
  hostCluster?: SolanaCluster;
  listedProviderReferences: readonly string[];
  /**
   * Authorizes a delist whose keep set is EMPTY, normally refused because
   * "the provider listed nothing" is indistinguishable from a broken read.
   * The mirror lane sets it when its truth source answered reliably (a
   * successful production fetch with no mainnet rows, or a steady-state "no
   * production catalogue"), so previously mirrored rows converge away instead
   * of being served forever as a catalogue production no longer vouches for.
   * Requires `hostCluster`: an authorized-empty delist may deprecate one
   * cluster sub-shelf, never a whole environment.
   */
  allowEmptyKeepSet?: true;
}

export interface ListEarnStrategiesInput {
  environment: SdpEnvironment;
  id?: string;
  /** Caller filter, intersected with the server-owned provider allowlist. */
  provider?: string;
  depositMint?: string;
  /** Decimal APY fraction bounds; unavailable/malformed rates never match. */
  minApy?: string;
  maxApy?: string;
  /**
   * Restrict to one cluster's sub-shelf. Server-resolved, never a raw caller
   * value: the strategies route defaults it to the environment's own cluster so
   * a sandbox catalogue keeps answering devnet by default, and threads the
   * caller's explicit `?cluster=` opt-in through to browse the mirrored mainnet
   * shelf (PRO-1742). A NULL `host_cluster` row counts as the environment's own
   * cluster — mapStrategyRow's rule. Callers that want every cluster (the
   * internal catalogue reads) simply omit it.
   */
  hostCluster?: SolanaCluster;
  sourceKind?: EarnStrategySourceKind;
  apyType?: EarnApyType;
  liquidityTerm?: EarnLiquidityTerm;
  includeInactive?: boolean;
  /**
   * Server-owned visibility terms matched case-insensitively against the
   * provider reference, display name, and underlying source. Filtering belongs
   * in the query so pagination and totals describe the rows callers can see;
   * the sync still persists the provider's complete routable catalogue.
   */
  excludeRelatedTerms?: readonly string[];
  /**
   * Server-owned provider allowlist — the offered set
   * (`SURFACED_EARN_PROVIDERS`), never a caller's filter.
   *
   * An EMPTY array means "no provider is offered" and returns nothing. That is
   * the whole point of accepting the array rather than an optional single id:
   * the caller passes the offered set as-is, and the degenerate case cannot
   * quietly invert into "no filter, show everything" at a call site that forgot
   * to check. Filtering belongs in the query for the same reason
   * `excludeRelatedTerms` does — so pagination and totals describe the rows the
   * caller can actually see.
   */
  providers?: readonly string[];
  /**
   * Server-owned per-vault denylist, as `<provider>:<providerReference>` keys.
   *
   * Keyed on the provider REFERENCE — a vault address — never on the name.
   * Kamino's vault registry is permissionless and the name is free text chosen
   * by whoever created the vault, so a name-keyed rule is one an outsider can
   * dodge (rename) or trip (impersonate a curated vault's name).
   */
  excludeProviderKeys?: readonly string[];
  /**
   * Per-provider allowlists: `{ kamino: [ref, ...] }` shows ONLY those
   * references for that provider and hides the rest of its shelf. A provider
   * absent from this map is unrestricted; a provider mapped to an EMPTY array
   * shows nothing, which is the literal reading of an empty allowlist and is
   * pinned by a repository test.
   */
  allowedProviderReferences?: Readonly<Record<string, readonly string[]>>;
  limit: number;
  offset: number;
}

/**
 * The volatile figures of one stored strategy, as the anomaly check reads them
 * before a catalogue or metrics write (PRO-1867, threat model EARN-010).
 * `tvl_usd` is lifted out of the `risk_metadata` bag and is null unless the
 * stored value is a JSON number, the same guard `listStrategies` ranks by.
 */
interface EarnStrategyFigureRow {
  provider_reference: string;
  host_cluster: SolanaCluster;
  status: EarnStrategyStatus;
  current_apy: string | null;
  tvl_usd: number | null;
}

export interface ListEarnStrategiesResult {
  rows: EarnStrategyRow[];
  total: number;
}

export interface EarnRepository {
  upsertStrategy(input: UpsertEarnStrategyInput): Promise<EarnStrategyRow | null>;
  /**
   * Upsert one provider catalogue lane in a single database statement.
   * The statement is atomic; callers may fall back to isolated writes to
   * identify a malformed row without turning a partial lane into a delist.
   */
  upsertStrategies(inputs: readonly UpsertEarnStrategyInput[]): Promise<number>;
  /**
   * Refresh the volatile figures on ONE already-catalogued strategy.
   *
   * Update-only by design — it can never insert. The catalogue's admission
   * gates live in the provider clients and run on the hourly sync; a write path
   * that could create a row would be a second, ungated way in. An unmatched
   * (provider, reference, environment) is a silent no-op, which is what lets
   * the refresh pass hand over a provider's whole shelf without first working
   * out which of it we catalogue.
   *
   * Returns whether a row was updated, so the caller can report coverage.
   */
  updateStrategyMetrics(input: UpdateEarnStrategyMetricsInput): Promise<boolean>;
  /** Update a provider's volatile figures in one round trip. */
  updateStrategyMetricsBatch(inputs: readonly UpdateEarnStrategyMetricsInput[]): Promise<number>;
  getStrategyById(strategyId: string): Promise<EarnStrategyRow | null>;
  /**
   * The catalogue row for one vault, by the identity a movement row carries
   * (provider + on-chain reference + environment; unique per 0048). For callers
   * that hold a ledger row rather than a strategy id, such as the vault
   * exposure cap's re-check inside the ledger write.
   */
  getStrategyByReference(input: {
    provider: string;
    providerReference: string;
    environment: SdpEnvironment;
  }): Promise<EarnStrategyRow | null>;
  listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult>;
  /**
   * Every stored strategy's volatile figures for one (provider, environment),
   * both clusters and every status: the "before" the catalogue sync and the
   * metrics refresh diff their incoming figures against (PRO-1867). Whole shelf
   * on purpose, so a paused row's rate moving 10x is still visible.
   */
  listStrategyFigures(params: {
    provider: string;
    environment: SdpEnvironment;
  }): Promise<EarnStrategyFigureRow[]>;
  /**
   * Every catalogued strategy that mints a share token on the given cluster,
   * for share-mint → vault attribution (PRO-1741). The WHOLE stored inventory
   * on purpose: no status filter and no curation, because a held share of a
   * paused or hidden vault still identifies real money. Cluster-scoped so a
   * sandbox environment's browse-only mainnet mirror (PRO-1742) can never
   * claim a balance read from the environment's own cluster.
   */
  listShareMintedStrategies(params: {
    environment: SdpEnvironment;
    hostCluster: SolanaCluster;
  }): Promise<EarnStrategyRow[]>;
  /**
   * Deprecate every `active` strategy for (provider, environment), optionally
   * narrowed to one cluster's sub-shelf — that the provider no longer lists.
   * Returns the transitioned provider references so the caller can log exactly
   * what left the live catalogue. Idempotent: a second pass over the same keep
   * set matches nothing.
   *
   * The retained row is metadata, not a browsable or depositable strategy: its
   * stable id and immutable provider/vault/mint identity keep resolving after
   * delisting. `catalogue_delisted_at` distinguishes this
   * sync-owned deprecation from a sticky operator status and lets a later
   * provider relist reactivate the same id safely.
   */
  deprecateUnlistedStrategies(input: DeprecateUnlistedEarnStrategiesInput): Promise<string[]>;
}
