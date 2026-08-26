import {
  EARN_BUTTON_PUBLIC_TOKEN_LENGTH,
  type EarnApyType,
  type EarnButtonStyle,
  type EarnLiquidityTerm,
  type EarnStrategyRiskMetadata,
  type EarnStrategySourceKind,
  type EarnStrategyStatus,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { customAlphabet } from "nanoid";

// URL-safe and deliberately longer than the existing payment-link token. This
// is a public locator rather than an API credential, but guessing it must still
// be impractical because possession is the only requirement to read the handoff.
// Length and shape are pinned in @sdp/types (EARN_BUTTON_PUBLIC_TOKEN_*) so the
// route, OpenAPI, and web validators cannot drift from this generator.
const EARN_BUTTON_PUBLIC_TOKEN_ALPHABET =
  // biome-ignore lint/security/noSecrets: token alphabet constant, not a secret.
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const generateEarnButtonPublicToken = customAlphabet(
  EARN_BUTTON_PUBLIC_TOKEN_ALPHABET,
  EARN_BUTTON_PUBLIC_TOKEN_LENGTH
);

export function generateEarnStrategyId(): string {
  return `earn_strategy_${crypto.randomUUID()}`;
}

export function generateEarnProviderWalletId(): string {
  return `earn_provider_wallet_${crypto.randomUUID()}`;
}

export function generateEarnButtonConfigurationId(): string {
  return `earn_button_config_${crypto.randomUUID()}`;
}

export function generateEarnButtonConfigurationPublicToken(): string {
  return generateEarnButtonPublicToken();
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
  liquidity_term: EarnLiquidityTerm;
  redemption_delay_days: number | null;
  risk_metadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
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

/**
 * Link to ONE provider-managed wallet — an Earn "program". An organization may
 * hold N of them per (environment, provider) since PRO-1670; each pins a single
 * vault and nothing rebalances across them. The uniqueness that used to cap this
 * at one row per (organization, environment, provider) is gone (migration 0056),
 * replaced by a GLOBAL UNIQUE (provider, provider_wallet_ref): a provider-side
 * wallet holds real funds, so exactly one link row may claim it platform-wide.
 *
 * project_id records the provisioning project only — it is not part of the
 * program's scope, and every project in an environment reaches every program.
 * It becomes null if that provisioning project is hard-deleted; the funded,
 * organization-scoped provider account survives.
 */
export interface EarnProviderWalletRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  /** Open TEXT, same drift rule as EarnStrategyRow.provider. */
  provider: string;
  /** Provider-side wallet identifier (e.g. Ground wallet UUID). */
  provider_wallet_ref: string;
  label: string | null;
  created_by: string;
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
  /** Merged over the stored metadata, so curator and friends survive. */
  riskMetadata: EarnStrategyRiskMetadata;
}

/**
 * Delist pass input: everything the provider still lists for (provider,
 * environment). Anything else the table holds is stale — a vault the provider
 * delisted or one a tightened catalogue gate now refuses — and is deleted.
 *
 * `listedProviderReferences` is the KEEP set, never the delete set, so the
 * caller cannot enumerate stale rows it does not know about: the provider's
 * live list is the only input, and the DB decides what that leaves behind.
 */
export interface DeleteUnlistedEarnStrategiesInput {
  provider: EarnProviderId;
  environment: SdpEnvironment;
  /**
   * Scope the delist to one cluster's sub-shelf. A non-production environment
   * holds two independently-sourced shelves since PRO-1742 — its own cluster's
   * catalogue plus the mirrored mainnet one — and each fetch may only delist
   * the rows it is the truth for: an unscoped delist run with one lane's keep
   * set would tear down the other lane's shelf. Omitted, the delist covers the
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
   * Requires `hostCluster`: an authorized-empty delist may tear down one
   * cluster sub-shelf, never a whole environment.
   */
  allowEmptyKeepSet?: true;
}

export interface ListEarnStrategiesInput {
  environment: SdpEnvironment;
  /**
   * Restrict to one cluster's sub-shelf. Server-resolved, never a raw caller
   * value: the strategies route defaults it to the environment's own cluster so
   * a sandbox catalogue keeps answering devnet by default, and threads the
   * caller's explicit `?cluster=` opt-in through to browse the mirrored mainnet
   * shelf (PRO-1742). A NULL `host_cluster` row counts as the environment's own
   * cluster — mapStrategyRow's rule. Callers that want every cluster (the
   * program-create keep set, which filters fundability itself) simply omit it.
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

export interface ListEarnStrategiesResult {
  rows: EarnStrategyRow[];
  total: number;
}

export interface InsertEarnProviderWalletInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: EarnProviderId;
  providerWalletRef: string;
  label: string | null;
  createdBy: string;
}

export interface ListEarnProviderWalletsInput {
  organizationId: string;
  environment: SdpEnvironment;
  /** Optional filter; omitted lists every provider's programs. */
  provider?: EarnProviderId;
  limit: number;
  offset: number;
}

export interface ListEarnProviderWalletsResult {
  rows: EarnProviderWalletRow[];
  total: number;
}

export interface EarnButtonConfigurationRow {
  id: string;
  public_token: string;
  organization_id: string;
  project_id: string;
  strategy_id: string;
  style: EarnButtonStyle;
  accent_color: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertEarnButtonConfigurationInput {
  organizationId: string;
  projectId: string;
  strategyId: string;
  style: EarnButtonStyle;
  accentColor: string;
  actorId: string;
}

export interface EarnRepository {
  getButtonConfiguration(params: {
    organizationId: string;
    projectId: string;
  }): Promise<EarnButtonConfigurationRow | null>;
  getButtonConfigurationByPublicToken(
    publicToken: string
  ): Promise<EarnButtonConfigurationRow | null>;
  upsertButtonConfiguration(
    input: UpsertEarnButtonConfigurationInput
  ): Promise<EarnButtonConfigurationRow>;
  upsertStrategy(input: UpsertEarnStrategyInput): Promise<EarnStrategyRow | null>;
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
  getStrategyById(strategyId: string): Promise<EarnStrategyRow | null>;
  listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult>;
  /**
   * DELETE every `active` strategy for (provider, environment) — optionally
   * narrowed to one cluster's sub-shelf — that the provider no longer lists.
   * Returns the deleted provider references so the caller can log exactly what
   * left the catalogue. Idempotent: a second pass over the same keep set
   * matches nothing.
   *
   * Deleted, not flagged: this table is a cache of the provider catalogue (the
   * sync is its only admitting writer) and nothing references a strategy id — no
   * foreign key, and a program's allocations carry the PROVIDER's reference,
   * resolved against live provider state. A status flag would leave rows SDP
   * must not carry sitting in the table indefinitely.
   */
  deleteUnlistedStrategies(input: DeleteUnlistedEarnStrategiesInput): Promise<string[]>;

  /**
   * One program by its own id, scoped to (organization, environment). The
   * program id is caller-supplied on every `/programs/:programId` route, so both
   * scopes are load-bearing: without organization_id a guessed id reads another
   * tenant's program, and without environment a sandbox id resolves for a
   * production session (the pre-PRO-1670 (org, environment, provider) lookup made
   * both structurally impossible; an addressable id does not).
   */
  getProviderWalletById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    walletId: string;
  }): Promise<EarnProviderWalletRow | null>;
  /**
   * Every program for an (organization, environment), oldest first. The order is
   * a stability requirement, not a preference — see migration 0056's header.
   */
  listProviderWallets(input: ListEarnProviderWalletsInput): Promise<ListEarnProviderWalletsResult>;
  /**
   * Lookup by the provider-side wallet ref, keyed on 0056's global unique. The
   * create path needs this without an organization scope to resolve a provider
   * replay: the provider answers a retried create with the ORIGINAL ref, so the
   * insert lands on that unique and the row it collided with IS the caller's
   * program. The caller asserts ownership after the fetch, exactly as
   * getProgramWithdrawalByProviderReference does.
   */
  getProviderWalletByRef(params: {
    provider: EarnProviderId;
    providerWalletRef: string;
  }): Promise<EarnProviderWalletRow | null>;
  insertProviderWallet(input: InsertEarnProviderWalletInput): Promise<EarnProviderWalletRow | null>;
}
