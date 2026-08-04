/**
 * Token Service
 *
 * Manages token issuance, including CRUD operations,
 * allowlist management, and freeze/unfreeze operations.
 */

import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import type {
  AllowlistEntryStatus,
  FrozenAccount,
  Token,
  TokenAllowlistEntry,
  TokenExtensionsConfig,
  TokenStatus,
  TokenTemplate,
  TokenTransaction,
  TokenTransactionListItem,
  TokenTransactionStatus,
  TokenTransactionType,
} from "@sdp/types";
import { isPostgresUniqueViolation, parsePostgresJsonOr } from "@/db/postgres-utils";
import { AppError, badRequest } from "@/lib/errors";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";

// How long a mint can still land after SDP last touched its row. A Solana blockhash
// is valid for ~150 slots (roughly 60-90s), so a transaction older than this can no
// longer be submitted; five minutes leaves generous room for a slow signer without
// letting an abandoned mint hold the supply record hostage.
const MINT_IN_FLIGHT_WINDOW_MS = 5 * 60 * 1000;

// Escapes LIKE/ILIKE wildcards so operator-supplied search text matches
// literally (mirrors the payments/policy repositories' `ESCAPE '\'` idiom).
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

// ═══════════════════════════════════════════════════════════════════════════
// Token List Filtering
// ═══════════════════════════════════════════════════════════════════════════

export type TokenListSortBy = "createdAt" | "name";
export type TokenDeploymentStatusFilter = "draft" | "active" | "paused";

/**
 * A token counts as deployed once it has a mint address or a deploy timestamp —
 * the same test the dashboard applies client-side, so server-side filtering and
 * the rendered badge can't disagree.
 */
const TOKEN_DEPLOYED_PREDICATE = "(mint_address IS NOT NULL OR deployed_at IS NOT NULL)";

/** Lifecycle state as presented, derived from deployed-ness + the raw status. */
const TOKEN_DEPLOYMENT_STATUS_PREDICATES: Record<TokenDeploymentStatusFilter, string> = {
  draft: `NOT ${TOKEN_DEPLOYED_PREDICATE}`,
  active: `${TOKEN_DEPLOYED_PREDICATE} AND status <> 'paused'`,
  paused: `${TOKEN_DEPLOYED_PREDICATE} AND status = 'paused'`,
};

/**
 * Contains-style search haystack. Must stay character-for-character in step with
 * `idx_issued_tokens_search_trgm` — a mismatched expression silently drops the
 * trigram index and turns every search into a sequential scan.
 */
const TOKEN_SEARCH_EXPRESSION =
  "(name || ' ' || symbol || ' ' || COALESCE(mint_address, '') || ' ' || id)";

/**
 * Whitelist of sortable keys → physical SQL. Callers only ever supply a key, so
 * no caller-controlled text reaches the ORDER BY clause.
 */
const TOKEN_LIST_SORT_COLUMNS: Record<TokenListSortBy, string> = {
  createdAt: "created_at",
  // LOWER() matches the dashboard's case-insensitive name ordering and the
  // expression indexed by idx_issued_tokens_project_name.
  name: "LOWER(name)",
};

export interface ListTokensFilters {
  status?: TokenStatus;
  deploymentStatus?: TokenDeploymentStatusFilter;
  template?: string;
  /** Contains-style, case-insensitive; wildcards are matched literally. */
  search?: string;
  /** Inclusive ISO-8601 lower bound on `created_at`. */
  createdAfter?: string;
  /** Inclusive ISO-8601 upper bound on `created_at`. */
  createdBefore?: string;
}

export interface ListTokensOptions extends ListTokensFilters {
  sortBy?: TokenListSortBy;
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface TokenListFacets {
  /** Template ids actually present in the project, with row counts. */
  templates: Array<{ template: string; count: number }>;
  /** Row counts per derived lifecycle state. */
  deploymentStatuses: Record<TokenDeploymentStatusFilter, number>;
  /** Unfiltered project total — lets the client tell "no assets" from "no matches". */
  total: number;
}

/**
 * Builds the WHERE clause shared by the list query, its count query and the
 * facet counts, so a filtered page and its total can never diverge.
 */
function buildTokenListFilter(
  projectId: string,
  filters: ListTokensFilters
): { whereClause: string; values: Array<string | number> } {
  const clauses = ["project_id = ?"];
  const values: Array<string | number> = [projectId];

  if (filters.status) {
    clauses.push("status = ?");
    values.push(filters.status);
  }

  if (filters.deploymentStatus) {
    clauses.push(`(${TOKEN_DEPLOYMENT_STATUS_PREDICATES[filters.deploymentStatus]})`);
  }

  if (filters.template) {
    clauses.push("template = ?");
    values.push(filters.template);
  }

  if (filters.search) {
    clauses.push(`${TOKEN_SEARCH_EXPRESSION} ILIKE ? ESCAPE '\\'`);
    values.push(`%${escapeLikePattern(filters.search)}%`);
  }

  if (filters.createdAfter) {
    clauses.push("created_at >= ?");
    values.push(filters.createdAfter);
  }

  if (filters.createdBefore) {
    clauses.push("created_at <= ?");
    values.push(filters.createdBefore);
  }

  return { whereClause: clauses.join(" AND "), values };
}

// ═══════════════════════════════════════════════════════════════════════════
// Input Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateTokenInput {
  projectId: string;
  organizationId: string;
  createdBy: string;
  signingWalletId?: string | null;
  name: string;
  symbol: string;
  decimals?: number;
  description?: string;
  uri?: string;
  imageUrl?: string;
  template?: TokenTemplate;
  extensions?: TokenExtensionsConfig;
  maxSupply?: string;
  isMintable?: boolean;
  isFreezable?: boolean;
  requiresAllowlist?: boolean;
}

export interface UpdateTokenInput {
  name?: string;
  /** Only accepted while the token is undeployed (enforced by the route handler). */
  symbol?: string;
  /** Only accepted while the token is undeployed (enforced by the route handler). */
  decimals?: number;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
  status?: "active" | "paused";
  signingWalletId?: string | null;
  /** Only accepted while the token is undeployed (enforced by the route handler). */
  requiresAllowlist?: boolean;
  /**
   * Whole-token decimal string, or null to uncap. Only accepted while the supply
   * is not yet locked on-chain (enforced by the route handler).
   */
  maxSupply?: string | null;
}

export interface CreateTokenTransactionInput {
  tokenId: string;
  organizationId: string;
  type: TokenTransactionType;
  params: Record<string, unknown>;
  serializedTx?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  initiatedByKeyId?: string;
}

export interface UpdateTokenTransactionInput {
  status?: TokenTransactionStatus;
  signature?: string;
  slot?: number;
  blockTime?: string;
  fee?: number;
  error?: string;
  /**
   * Attached only after the mint's supply reservation is admitted: a serialized
   * transaction in the row is readable through the transactions API and, in the
   * wallet-authority flow, submittable by whoever reads it — so a row must never
   * carry one the cap refused.
   */
  serializedTx?: string;
  params?: Record<string, unknown>;
}

export interface CreateTransactionResult {
  transaction: TokenTransaction;
  replayed: boolean;
}

/**
 * Public-facing token metadata fields served by the unauthenticated
 * `GET /v1/issuance/tokens/:id/metadata.json` route. Deliberately a narrow
 * subset of `Token` — never authority/mint/internal columns.
 */
export interface PublicTokenMetadata {
  name: string;
  symbol: string;
  description: string | null;
  imageUrl: string | null;
}

/**
 * Outcome of a public metadata lookup. Distinguishes a deployed token (servable)
 * from a known-but-undeployed one and an unknown id, so the route can cache the
 * 404 differently: a pending id may flip to 200 within seconds of deploy and
 * must not stick a stale 404, while an unknown id never resolves and is safe to
 * negative-cache against enumeration.
 */
export type PublicTokenMetadataResult =
  | { status: "deployed"; metadata: PublicTokenMetadata }
  | { status: "pending" }
  | { status: "not_found" };

export interface AddAllowlistInput {
  tokenId: string;
  address: string;
  addedBy: string;
  label?: string;
  initialStatus?: Extract<AllowlistEntryStatus, "pending" | "active">;
}

export interface FreezeAccountInput {
  tokenId: string;
  accountAddress: string;
  frozenBy: string;
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Database Row Types
// ═══════════════════════════════════════════════════════════════════════════

interface TokenRow {
  id: string;
  project_id: string;
  organization_id: string;
  signing_wallet_id: string | null;
  mint_address: string | null;
  mint_authority: string | null;
  metadata_authority: string | null;
  freeze_authority: string | null;
  abl_list_address: string | null;
  name: string;
  symbol: string;
  decimals: number;
  description: string | null;
  uri: string | null;
  image_url: string | null;
  template: string;
  total_supply_cached: string;
  total_supply_updated_at: string | null;
  max_supply: string | null;
  is_mintable: number;
  freeze_authority_enabled: number;
  allowlist_enabled: number;
  status: string;
  deployed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface TokenExtensionRow {
  extension: string;
  config: string | null;
}

interface TokenExtensionState {
  extensions: TokenExtensionsConfig | null;
  metadataAuthority: string | null;
}

interface TokenTransactionRow {
  id: string;
  token_id: string;
  organization_id: string;
  type: string;
  status: string;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  signature: string | null;
  serialized_tx: string | null;
  operation_params: string;
  slot: number | null;
  block_time: string | null;
  fee: number | null;
  error: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenTransactionListRow extends TokenTransactionRow {
  token_name: string;
  token_symbol: string;
  token_mint_address: string | null;
}

interface AllowlistRow {
  id: string;
  token_id: string;
  address: string;
  label: string | null;
  status: string;
  added_by: string;
  created_at: string;
  revoked_at: string | null;
}

interface FrozenAccountRow {
  id: string;
  token_id: string;
  account_address: string;
  reason: string | null;
  frozen_at: string;
  frozen_by: string;
  unfrozen_at: string | null;
  unfrozen_by: string | null;
}

interface WalletTransactionMatchConfig {
  publicKeyFields: readonly string[];
  tokenAccountFields: readonly string[];
}

const WALLET_TRANSACTION_MATCH_CONFIG = {
  mint: {
    publicKeyFields: ["destination"],
    tokenAccountFields: ["destination", "tokenAccount"],
  },
  burn: {
    publicKeyFields: ["source"],
    tokenAccountFields: ["source"],
  },
  freeze: {
    publicKeyFields: ["accountAddress"],
    tokenAccountFields: ["accountAddress"],
  },
  unfreeze: {
    publicKeyFields: ["accountAddress"],
    tokenAccountFields: ["accountAddress"],
  },
  seize: {
    publicKeyFields: ["source", "destination"],
    tokenAccountFields: ["source", "destination"],
  },
  force_burn: {
    publicKeyFields: ["source"],
    tokenAccountFields: ["source"],
  },
  update_authority: {
    publicKeyFields: ["currentAuthority", "newAuthority"],
    tokenAccountFields: [],
  },
  pause: {
    publicKeyFields: [],
    tokenAccountFields: [],
  },
  unpause: {
    publicKeyFields: [],
    tokenAccountFields: [],
  },
  deploy: {
    publicKeyFields: [],
    tokenAccountFields: [],
  },
} satisfies Record<TokenTransactionType, WalletTransactionMatchConfig>;

interface TokenAccountMatch {
  tokenId: string;
  tokenAccount: string;
}

interface WalletTransactionScope {
  publicKeys: readonly string[];
  tokenAccounts?: readonly TokenAccountMatch[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Service
// ═══════════════════════════════════════════════════════════════════════════

export class TokenService {
  constructor(
    private db: DatabaseClient,
    private readonly tenantScope?: TenantScope
  ) {}

  private tenantMutationScope(): { clause: string; values: Array<string | null> } {
    if (!this.tenantScope) {
      return { clause: "", values: [] };
    }

    return {
      clause: " AND organization_id = ? AND project_id IS NOT DISTINCT FROM ?",
      values: [this.tenantScope.organizationId, this.tenantScope.projectId],
    };
  }

  private tenantTokenScope(alias = ""): { clause: string; values: Array<string | null> } {
    if (!this.tenantScope) {
      return { clause: "", values: [] };
    }

    const prefix = alias ? `${alias}.` : "";
    return {
      clause: ` AND ${prefix}organization_id = ? AND ${prefix}project_id IS NOT DISTINCT FROM ?`,
      values: [this.tenantScope.organizationId, this.tenantScope.projectId],
    };
  }

  /**
   * Enforce the service's immutable tenant boundary before touching a child
   * resource keyed only by token id. Token ownership is immutable, so this
   * check remains valid for the following child-row operation.
   */
  private async assertTokenInTenant(tokenId: string): Promise<void> {
    if (!this.tenantScope) {
      return;
    }

    const row = await this.db
      .prepare(
        `SELECT id
         FROM issued_tokens
         WHERE id = ? AND organization_id = ? AND project_id IS NOT DISTINCT FROM ?`
      )
      .bind(tokenId, this.tenantScope.organizationId, this.tenantScope.projectId)
      .first<{ id: string }>();

    if (!row) {
      throw new Error("TOKEN_NOT_FOUND");
    }
  }

  private assertTenantOptions(options: {
    organizationId: string;
    projectId?: string | null;
  }): void {
    if (!this.tenantScope) {
      return;
    }

    assertTenantClaim(
      this.tenantScope,
      {
        organizationId: options.organizationId,
        projectId: options.projectId ?? null,
      },
      "TokenService"
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Token CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async createToken(input: CreateTokenInput): Promise<Token> {
    if (this.tenantScope) {
      assertTenantClaim(
        this.tenantScope,
        { organizationId: input.organizationId, projectId: input.projectId },
        "TokenService"
      );
    }
    const id = `tok_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const decimals = input.decimals ?? 9;
    // parseDecimalAmount throws when the cap carries more decimal places than the
    // mint supports. It can't be caught in the request schema: callers resolve
    // template settings first, and a template may pin `decimals` to something
    // other than what the caller asked for — so the effective precision is only
    // known here. Surface it as a 400 rather than letting AmountError escape.
    let maxSupplyBaseUnits: string | null = null;
    if (input.maxSupply) {
      try {
        maxSupplyBaseUnits = parseDecimalAmount(input.maxSupply, decimals).toString();
      } catch {
        throw badRequest("Invalid maxSupply for this token's decimals", {
          errors: {
            maxSupply: [`Must be a number with at most ${decimals} decimal place(s)`],
          },
        });
      }
    }

    const token: Token = {
      id,
      projectId: input.projectId,
      organizationId: input.organizationId,
      signingWalletId: input.signingWalletId ?? null,
      mintAddress: null,
      mintAuthority: null,
      freezeAuthority: null,
      ablListAddress: null,
      name: input.name,
      symbol: input.symbol,
      decimals,
      description: input.description ?? null,
      uri: input.uri ?? null,
      imageUrl: input.imageUrl ?? null,
      template: input.template ?? "custom",
      extensions: input.extensions ?? null,
      totalSupply: "0",
      totalSupplyUpdatedAt: now,
      maxSupply: input.maxSupply ?? null,
      isMintable: input.isMintable ?? true,
      isFreezable: input.isFreezable ?? true,
      requiresAllowlist: input.requiresAllowlist ?? false,
      status: "pending",
      deployedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await this.db
      .prepare(
        `INSERT INTO issued_tokens (
          id, project_id, organization_id, signing_wallet_id, mint_address, mint_authority, metadata_authority, freeze_authority,
          abl_list_address, name, symbol, decimals, description, uri, image_url, template,
          total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
          freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        token.id,
        token.projectId,
        token.organizationId,
        token.signingWalletId,
        token.mintAddress,
        token.mintAuthority,
        token.metadataAuthority ?? null,
        token.freezeAuthority,
        token.ablListAddress,
        token.name,
        token.symbol,
        token.decimals,
        token.description,
        token.uri,
        token.imageUrl,
        token.template,
        parseDecimalAmount(token.totalSupply, decimals).toString(),
        token.totalSupplyUpdatedAt,
        maxSupplyBaseUnits,
        token.isMintable ? 1 : 0,
        token.isFreezable ? 1 : 0,
        token.requiresAllowlist ? 1 : 0,
        token.status,
        token.deployedAt,
        token.createdBy,
        token.createdAt,
        token.updatedAt
      )
      .run();

    if (token.extensions) {
      await this.insertTokenExtensions(token.id, token.extensions, token.createdAt);
    }

    return token;
  }

  /**
   * Get a token scoped to the caller's organization + project. Returns null if
   * the token belongs to a different org or project — this is the entry-point
   * validation that closes cross-project reads. Handlers must use this method;
   * service-internal callers can use `_getTokenById` when they already trust
   * the id (typically because a scoped lookup succeeded earlier in the flow).
   */
  async getToken(params: {
    tokenId: string;
    organizationId: string;
    projectId: string;
  }): Promise<Token | null> {
    if (this.tenantScope) {
      assertTenantClaim(this.tenantScope, params, "TokenService");
    }
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                signing_wallet_id,
                abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                created_at, updated_at
         FROM issued_tokens WHERE id = ? AND organization_id = ? AND project_id = ?`
      )
      .bind(params.tokenId, params.organizationId, params.projectId)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    const extensionState = await this.getTokenExtensionState(params.tokenId);
    return this.mapRowToToken(row, extensionState);
  }

  private async _getTokenById(tokenId: string): Promise<Token | null> {
    const tenantWhere = this.tenantScope
      ? " AND organization_id = ? AND project_id IS NOT DISTINCT FROM ?"
      : "";
    const tenantValues = this.tenantScope
      ? [this.tenantScope.organizationId, this.tenantScope.projectId]
      : [];
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                signing_wallet_id,
                abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                created_at, updated_at
         FROM issued_tokens WHERE id = ?${tenantWhere}`
      )
      .bind(tokenId, ...tenantValues)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    const extensionState = await this.getTokenExtensionState(tokenId);
    return this.mapRowToToken(row, extensionState);
  }

  /**
   * Fetch the public-facing metadata for a token by id alone.
   *
   * Unscoped by org/project on purpose: this backs the public
   * `GET /v1/issuance/tokens/:id/metadata.json` route that wallets and
   * explorers fetch without credentials. Returns only the fields rendered in
   * the served JSON.
   *
   * Only deployed tokens (`mint_address` set) are served, so a pending draft's
   * name/symbol/description/image can't be retrieved publicly by guessing its id
   * — only on-chain tokens, whose metadata is already public, are returned.
   * Pending vs unknown ids are reported distinctly (`mint_address` is read but
   * never exposed) purely so the route can pick the right 404 cache policy.
   */
  async getPublicTokenMetadata(tokenId: string): Promise<PublicTokenMetadataResult> {
    const row = await this.db
      .prepare(
        "SELECT name, symbol, description, image_url, mint_address FROM issued_tokens WHERE id = ?"
      )
      .bind(tokenId)
      .first<{
        name: string;
        symbol: string;
        description: string | null;
        image_url: string | null;
        mint_address: string | null;
      }>();

    if (!row) {
      return { status: "not_found" };
    }

    if (!row.mint_address) {
      return { status: "pending" };
    }

    return {
      status: "deployed",
      metadata: {
        name: row.name,
        symbol: row.symbol,
        description: row.description,
        imageUrl: row.image_url,
      },
    };
  }

  async getTokenByMint(mintAddress: string): Promise<Token | null> {
    const tenant = this.tenantTokenScope();
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                signing_wallet_id,
                abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                created_at, updated_at
         FROM issued_tokens WHERE mint_address = ?${tenant.clause}`
      )
      .bind(mintAddress, ...tenant.values)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    const extensionState = await this.getTokenExtensionState(row.id);
    return this.mapRowToToken(row, extensionState);
  }

  /**
   * Page a project's tokens with server-side search, filtering and sorting.
   *
   * `total` reflects the active filters, so it is the count the caller should
   * page against. Ordering always ends in an `id` tiebreaker in the same
   * direction as the sort key, so rows sharing a `created_at` (or a name) can't
   * repeat or vanish between pages, and the composite indexes can serve the
   * whole ordering without a separate sort step.
   */
  async listTokens(
    projectId: string,
    options: ListTokensOptions = {}
  ): Promise<{ tokens: Token[]; total: number }> {
    if (this.tenantScope && this.tenantScope.projectId !== projectId) {
      throw new AppError("FORBIDDEN", "Token project is outside the authenticated tenant");
    }
    const { limit = 50, offset = 0, sortBy = "createdAt", sortDirection = "desc" } = options;

    const { whereClause, values } = buildTokenListFilter(projectId, options);
    const tenant = this.tenantTokenScope();
    const scopedWhereClause = `${whereClause}${tenant.clause}`;
    const scopedValues = [...values, ...tenant.values];
    const sortColumn = TOKEN_LIST_SORT_COLUMNS[sortBy] ?? TOKEN_LIST_SORT_COLUMNS.createdAt;
    const direction = sortDirection === "asc" ? "ASC" : "DESC";

    const [countResult, result] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*)::int as count FROM issued_tokens WHERE ${scopedWhereClause}`)
        .bind(...scopedValues)
        .first<{ count: number }>(),
      this.db
        .prepare(
          `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                  signing_wallet_id,
                  abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                  total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                  freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                  created_at, updated_at
           FROM issued_tokens
           WHERE ${scopedWhereClause}
           ORDER BY ${sortColumn} ${direction}, id ${direction}
           LIMIT ? OFFSET ?`
        )
        .bind(...scopedValues, limit, offset)
        .all<TokenRow>(),
    ]);

    const extensionMap = await this.getExtensionStatesForTokens(
      result.results.map((row) => row.id)
    );

    return {
      tokens: result.results.map((row) =>
        this.mapRowToToken(
          row,
          extensionMap.get(row.id) ?? { extensions: null, metadataAuthority: null }
        )
      ),
      total: countResult?.count ?? 0,
    };
  }

  /**
   * Filter facets for a project's token list: which templates exist (so the
   * dashboard's filter options aren't limited to the rows on the current page),
   * how many tokens sit in each lifecycle state, and the unfiltered total.
   *
   * Deliberately unfiltered — these are the choices offered *before* filtering,
   * and the unfiltered total is what separates an empty project from an
   * over-filtered one.
   */
  async listTokenFacets(projectId: string): Promise<TokenListFacets> {
    if (this.tenantScope && this.tenantScope.projectId !== projectId) {
      throw new AppError("FORBIDDEN", "Token project is outside the authenticated tenant");
    }
    const tenant = this.tenantTokenScope();
    const [templateRows, counts] = await Promise.all([
      this.db
        .prepare(
          `SELECT template, COUNT(*)::int as count
           FROM issued_tokens
           WHERE project_id = ?${tenant.clause}
           GROUP BY template
           ORDER BY template ASC`
        )
        .bind(projectId, ...tenant.values)
        .all<{ template: string | null; count: number }>(),
      this.db
        .prepare(
          `SELECT COUNT(*)::int as total,
                  COUNT(*) FILTER (WHERE ${TOKEN_DEPLOYMENT_STATUS_PREDICATES.draft})::int as draft,
                  COUNT(*) FILTER (WHERE ${TOKEN_DEPLOYMENT_STATUS_PREDICATES.active})::int as active,
                  COUNT(*) FILTER (WHERE ${TOKEN_DEPLOYMENT_STATUS_PREDICATES.paused})::int as paused
           FROM issued_tokens
           WHERE project_id = ?${tenant.clause}`
        )
        .bind(projectId, ...tenant.values)
        .first<{ total: number; draft: number; active: number; paused: number }>(),
    ]);

    return {
      // `template` is NOT NULL in practice but defensive: a null would otherwise
      // surface as an unselectable blank option.
      templates: templateRows.results
        .filter((row): row is { template: string; count: number } => Boolean(row.template))
        .map((row) => ({ template: row.template, count: row.count })),
      deploymentStatuses: {
        draft: counts?.draft ?? 0,
        active: counts?.active ?? 0,
        paused: counts?.paused ?? 0,
      },
      total: counts?.total ?? 0,
    };
  }

  async updateToken(
    tokenId: string,
    input: UpdateTokenInput,
    expectedDeploymentState?: Pick<Token, "status" | "mintAddress">
  ): Promise<Token> {
    const existing = await this._getTokenById(tokenId);
    if (!existing) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
    }

    if (input.symbol !== undefined) {
      updates.push("symbol = ?");
      values.push(input.symbol);
    }

    if (input.decimals !== undefined) {
      updates.push("decimals = ?");
      values.push(input.decimals);
    }

    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }

    if (input.uri !== undefined) {
      updates.push("uri = ?");
      values.push(input.uri);
    }

    if (input.imageUrl !== undefined) {
      updates.push("image_url = ?");
      values.push(input.imageUrl);
    }

    if (input.status !== undefined) {
      updates.push("status = ?");
      values.push(input.status);
    }

    if (input.signingWalletId !== undefined) {
      updates.push("signing_wallet_id = ?");
      values.push(input.signingWalletId);
    }

    if (input.requiresAllowlist !== undefined) {
      updates.push("allowlist_enabled = ?");
      values.push(input.requiresAllowlist ? 1 : 0);
    }

    // The supply the cap was validated against, kept so the write can be guarded
    // on that same read — see the guards below.
    let supplyAtCapCheck: string | null = null;
    if (input.maxSupply !== undefined) {
      const resolved = await this._resolveMaxSupplyBaseUnits(input, existing);
      supplyAtCapCheck = resolved.supplyBaseUnits;
      updates.push("max_supply = ?");
      values.push(resolved.maxSupplyBaseUnits);
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push("updated_at = ?");
    values.push(now);

    // symbol/decimals/requiresAllowlist are only mutable pre-deploy. The route
    // handler enforces that from a read of `existing`, but a concurrent
    // `deployToken` can flip status/mint_address between that read and this
    // write. Re-assert the pending/undeployed condition inside the UPDATE
    // itself (optimistic lock) so the race loses the write — matching 0 rows —
    // instead of silently mutating a mint that's already in flight on-chain.
    const requiresUndeployedGuard =
      input.symbol !== undefined ||
      input.decimals !== undefined ||
      input.requiresAllowlist !== undefined;
    const requiresStableDeploymentGuard =
      input.name !== undefined ||
      input.description !== undefined ||
      input.uri !== undefined ||
      input.imageUrl !== undefined ||
      input.status !== undefined;

    // Same race, one step later in the lifecycle: the cap is only meaningful
    // while the mint authority still exists, and a concurrent lock-supply can
    // revoke it between the handler's read and this write.
    const requiresUnlockedSupplyGuard =
      input.maxSupply !== undefined && Boolean(existing.mintAddress);

    const whereConditions = ["id = ?"];
    const whereValues: (string | null)[] = [tokenId];
    if (requiresUndeployedGuard) {
      whereConditions.push("status = 'pending'", "mint_address IS NULL");
    } else if (requiresStableDeploymentGuard) {
      whereConditions.push("status <> 'deploying'");
    }
    if (requiresUnlockedSupplyGuard) {
      whereConditions.push("is_mintable = 1", "mint_authority IS NOT NULL");
    }
    // And the same race one step further out: the cap was checked against a supply
    // read, and a mint landing in this window is exactly what makes that read
    // stale. Guarding on it means losing to a mint costs a 409 the operator can
    // retry against the real supply, rather than storing a cap below what was just
    // minted. (COALESCE because the column is nullable, and NULL never equals a
    // bound value.)
    if (supplyAtCapCheck !== null) {
      whereConditions.push("COALESCE(total_supply_cached, '0') = ?");
      whereValues.push(supplyAtCapCheck);
    }
    if (expectedDeploymentState) {
      whereConditions.push("status = ?", "mint_address IS NOT DISTINCT FROM ?");
      whereValues.push(expectedDeploymentState.status, expectedDeploymentState.mintAddress);
    }
    if (this.tenantScope) {
      whereConditions.push("organization_id = ?", "project_id IS NOT DISTINCT FROM ?");
      whereValues.push(this.tenantScope.organizationId, this.tenantScope.projectId);
    }

    const rowsAffected = await this.db
      .prepare(
        `UPDATE issued_tokens SET ${updates.join(", ")} WHERE ${whereConditions.join(" AND ")}`
      )
      .bind(...values, ...whereValues)
      .run();

    // The row existed at the top-of-method read, so a guarded 0-row result means
    // the lifecycle moved on during the window — surface a 409 rather than a 404.
    if (
      (requiresUndeployedGuard ||
        requiresStableDeploymentGuard ||
        requiresUnlockedSupplyGuard ||
        supplyAtCapCheck !== null ||
        expectedDeploymentState) &&
      rowsAffected === 0
    ) {
      throw new AppError("CONFLICT", await this._describeUpdateConflict(existing));
    }

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * The `max_supply` column value for an update: base units, or null to uncap.
   *
   * Mirrors `createToken`'s parse — precision is checked against the effective
   * decimals, which a pre-deploy update may be changing in the same request —
   * and additionally refuses a cap the token has already outgrown, since minting
   * can only ever push the total further past it.
   *
   * Returns the supply it compared against, in base units, so the caller can
   * guard the write on that same read: a mint landing in between is exactly what
   * would make a cap that passed this check wrong by the time it is stored. Read
   * from the column rather than round-tripped through `existing.totalSupply`,
   * which is formatted for display and would not compare byte-for-byte.
   */
  private async _resolveMaxSupplyBaseUnits(
    input: UpdateTokenInput,
    existing: Token
  ): Promise<{ maxSupplyBaseUnits: string | null; supplyBaseUnits: string | null }> {
    // Clearing a cap depends on no supply at all — uncapping can never conflict
    // with a mint — so it neither reads one nor gets guarded on one.
    if (!input.maxSupply) {
      return { maxSupplyBaseUnits: null, supplyBaseUnits: null };
    }

    const decimals = input.decimals ?? existing.decimals;
    let baseUnits: bigint;
    try {
      baseUnits = parseDecimalAmount(input.maxSupply, decimals);
    } catch {
      throw badRequest("Invalid maxSupply for this token's decimals", {
        errors: {
          maxSupply: [`Must be a number with at most ${decimals} decimal place(s)`],
        },
      });
    }

    // Only compared for deployed tokens: their decimals are immutable (so both
    // sides share a scale) and a draft has no minted supply to undercut.
    if (!existing.mintAddress) {
      return { maxSupplyBaseUnits: baseUnits.toString(), supplyBaseUnits: null };
    }

    // The recorded supply counts every mint SDP has admitted — settled ones, and
    // reservations for ones that could still land, executed or prepared — because
    // `reserveMintSupply` runs before any transaction can reach the chain. So a cap
    // at or above this figure cannot be outrun by an in-flight mint, and the
    // supply-unchanged guard on the write catches one admitted in this window: the
    // reservation and the cap change contend for the same row, and whichever
    // commits second sees the other.
    const supplyBaseUnits = await this._getCachedSupplyBaseUnits(existing.id);
    if (baseUnits < BigInt(supplyBaseUnits)) {
      throw badRequest("maxSupply cannot be below the already-minted supply", {
        errors: {
          maxSupply: [
            `Must be at least the current supply of ${formatDecimalAmount(supplyBaseUnits, decimals)}`,
          ],
        },
      });
    }

    return { maxSupplyBaseUnits: baseUnits.toString(), supplyBaseUnits };
  }

  /**
   * The cached supply exactly as stored, for comparing against and then guarding
   * on. Anything that isn't a base-unit integer reads as `0`, so a malformed
   * cache can't make a cap check throw from inside a bigint parse.
   */
  private async _getCachedSupplyBaseUnits(tokenId: string): Promise<string> {
    const tenant = this.tenantTokenScope();
    const row = await this.db
      .prepare(
        `SELECT COALESCE(total_supply_cached, '0') AS supply
         FROM issued_tokens
         WHERE id = ?${tenant.clause}`
      )
      .bind(tokenId, ...tenant.values)
      .first<{ supply: string }>();
    const supply = row?.supply ?? "0";
    return /^\d+$/.test(supply) ? supply : "0";
  }

  /**
   * Why a guarded update matched no rows. The row existed at the top-of-method
   * read, so something moved it out from under one of the guards in the window —
   * re-read to name which, since a `maxSupply` update carries three of them and
   * an operator retrying deserves to know what actually changed.
   */
  private async _describeUpdateConflict(before: Token): Promise<string> {
    const after = await this._getTokenById(before.id);
    if (!after) {
      return "Token was deleted while this update was in flight; re-fetch and retry";
    }
    if (after.mintAddress && !before.mintAddress) {
      return "Token was deployed while this update was in flight; re-fetch and retry";
    }
    if (before.mintAddress && (!after.mintAuthority || !after.isMintable)) {
      return "Token supply was locked on-chain while this update was in flight; re-fetch and retry";
    }
    if (after.totalSupply !== before.totalSupply) {
      return "Token supply changed while this update was in flight; re-fetch and retry";
    }
    return "Token changed while this update was in flight; re-fetch and retry";
  }

  /**
   * Update token authority fields and related extensions.
   */
  async updateTokenAuthorities(
    tokenId: string,
    updates: {
      mintAuthority?: string | null;
      metadataAuthority?: string | null;
      isMintable?: boolean;
      freezeAuthority?: string | null;
      isFreezable?: boolean;
      permanentDelegate?: string | null;
    }
  ): Promise<Token> {
    const existing = await this._getTokenById(tokenId);
    if (!existing) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.mintAuthority !== undefined) {
      fields.push("mint_authority = ?");
      values.push(updates.mintAuthority);
    }

    if (updates.isMintable !== undefined) {
      fields.push("is_mintable = ?");
      values.push(updates.isMintable ? 1 : 0);
    }

    if (updates.metadataAuthority !== undefined) {
      fields.push("metadata_authority = ?");
      values.push(updates.metadataAuthority);
    }

    if (updates.freezeAuthority !== undefined) {
      fields.push("freeze_authority = ?");
      values.push(updates.freezeAuthority);
    }

    if (updates.isFreezable !== undefined) {
      fields.push("freeze_authority_enabled = ?");
      values.push(updates.isFreezable ? 1 : 0);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(now);
      values.push(tokenId);

      const tenant = this.tenantMutationScope();

      await this.db
        .prepare(`UPDATE issued_tokens SET ${fields.join(", ")} WHERE id = ?${tenant.clause}`)
        .bind(...values, ...tenant.values)
        .run();
    }

    if (updates.permanentDelegate !== undefined) {
      if (fields.length === 0) {
        const tenant = this.tenantMutationScope();
        await this.db
          .prepare(`UPDATE issued_tokens SET updated_at = ? WHERE id = ?${tenant.clause}`)
          .bind(now, tokenId, ...tenant.values)
          .run();
      }
      await this.setTokenExtension(tokenId, "permanentDelegate", updates.permanentDelegate, now);
    }

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * Atomically claim a pending token for deployment, flipping it to the
   * transient `deploying` state and returning the now-frozen snapshot.
   *
   * This closes the window the `updateToken` undeployed guard alone can't: a
   * deploy reads a pending token, then spends seconds creating the on-chain mint
   * from that snapshot, and only afterwards records `active` + the mint address.
   * Throughout that gap the row is still `pending`/no-mint, so a concurrent
   * identity PATCH (symbol/decimals/requiresAllowlist) would pass the guard and
   * mutate the row — permanently diverging the DB identity from the immutable
   * mint. Once claimed, the row is no longer `pending`, so both the route- and
   * service-level PATCH guards reject those edits for the whole mint window.
   *
   * Guarded on `pending`/no-mint so exactly one caller wins; returns null if the
   * token wasn't claimable (already deploying, deployed, or gone). `deploying`
   * is internal and transient — never surfaced long-term: it advances to
   * `active` via {@link setTokenDeployed} or back to `pending` via
   * {@link releaseTokenDeploy}.
   */
  async beginTokenDeploy(tokenId: string): Promise<Token | null> {
    const now = new Date().toISOString();
    const tenant = this.tenantMutationScope();
    const rowsAffected = await this.db
      .prepare(
        `UPDATE issued_tokens SET status = 'deploying', updated_at = ?
         WHERE id = ?${tenant.clause} AND status = 'pending' AND mint_address IS NULL`
      )
      .bind(now, tokenId, ...tenant.values)
      .run();

    if (rowsAffected === 0) {
      return null;
    }

    return this._getTokenById(tokenId);
  }

  /**
   * Release a `deploying` claim back to `pending` when a deploy fails before the
   * mint lands on-chain, so the draft stays editable and redeployable. Guarded
   * on `deploying`/no-mint, so it's a no-op once the mint is recorded (status
   * `active`) — safe to call unconditionally from a deploy catch block.
   */
  async releaseTokenDeploy(tokenId: string): Promise<void> {
    const now = new Date().toISOString();
    const tenant = this.tenantMutationScope();
    await this.db
      .prepare(
        `UPDATE issued_tokens SET status = 'pending', updated_at = ?
         WHERE id = ?${tenant.clause} AND status = 'deploying' AND mint_address IS NULL`
      )
      .bind(now, tokenId, ...tenant.values)
      .run();
  }

  async setTokenDeployed(
    tokenId: string,
    mintAddress: string,
    mintAuthority: string,
    freezeAuthority: string | null,
    ablListAddress?: string | null
  ): Promise<Token> {
    const now = new Date().toISOString();
    const tenant = this.tenantMutationScope();

    const rowsAffected = await this.db
      .prepare(
        `UPDATE issued_tokens SET
          mint_address = ?,
          mint_authority = ?,
          metadata_authority = ?,
          freeze_authority = ?,
          abl_list_address = ?,
          status = 'active',
          deployed_at = ?,
          updated_at = ?
         WHERE id = ?${tenant.clause}`
      )
      .bind(
        mintAddress,
        mintAuthority,
        mintAuthority,
        freezeAuthority,
        ablListAddress ?? null,
        now,
        now,
        tokenId,
        ...tenant.values
      )
      .run();

    if (rowsAffected === 0) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * Count a mint against the cap, atomically, before it can reach the chain —
   * executed mints at the moment of submission, prepared mints before the
   * serialized transaction is handed to the client.
   *
   * This — not the handler's read of a cached total — is where the cap is
   * enforced. Two requests that each check a cached supply in their own process
   * both pass and both land; two conditional UPDATEs against the same row cannot,
   * because the row lock serializes them and the second one adds to what the first
   * committed. A cap change touches the same row, so it serializes here too: it
   * either lands first (and this reservation fails against the lower cap) or
   * second (and it fails its own "not below the minted supply" check). The
   * recorded supply can no longer end up above the persisted cap.
   *
   * The reservation *is* the count: nothing adds to it when the transaction
   * settles, and nothing hands it back when the send fails — a send can fail
   * ambiguously, and giving the headroom back to a transaction that lands anyway is
   * how two mints end up above the cap. Only `setSupplyFromBaseUnits`, reading the
   * mint account itself, lowers the record, and only once the mint can no longer
   * land.
   *
   * @returns the recorded supply after reserving, or null if the cap refused it.
   */
  async reserveMintSupply(tokenId: string, deltaBaseUnits: string): Promise<string | null> {
    const now = new Date().toISOString();
    const tenant = this.tenantMutationScope();
    const row = await this.db
      .prepare(
        `UPDATE issued_tokens
         SET total_supply_cached = (COALESCE(total_supply_cached, '0')::numeric + ?::numeric)::text,
             total_supply_updated_at = ?,
             updated_at = ?
         WHERE id = ?${tenant.clause}
           AND (max_supply IS NULL
                OR COALESCE(total_supply_cached, '0')::numeric + ?::numeric <= max_supply::numeric)
         RETURNING total_supply_cached`
      )
      .bind(deltaBaseUnits, now, now, tokenId, ...tenant.values, deltaBaseUnits)
      .first<{ total_supply_cached: string }>();
    return row?.total_supply_cached ?? null;
  }

  /**
   * Record a supply change that has already settled on-chain — today, a burn.
   *
   * A cache write, not an admission check: the balance is enforced against the
   * authority's token account before the burn is sent, and re-checking a cached
   * total here could only report a settled burn as failed or leave the cache
   * ahead of the chain. Mints do not come through here at all; they are counted by
   * `reserveMintSupply` before they can reach the chain, because a cap cannot be
   * enforced after the fact — SPL has no cap of its own and a settled mint cannot
   * be taken back.
   */
  async updateSupply(tokenId: string, delta: string, operation: "mint" | "burn"): Promise<void> {
    const token = await this._getTokenById(tokenId);
    if (!token) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const deltaBaseUnits = parseDecimalAmount(delta, token.decimals).toString();
    await this._applySupplyDelta(
      tokenId,
      deltaBaseUnits,
      operation === "mint" ? "add" : "subtract"
    );
  }

  /**
   * Move the cached supply by a base-unit delta, in one statement.
   *
   * The arithmetic belongs in SQL. Reading the total, changing it in memory and
   * writing the sum back lost one of every concurrent pair — and the cache then
   * stayed short for good, which let admission pass mints the cap should have
   * refused. One UPDATE takes the row lock, so each change applies to whatever the
   * other left behind. Subtraction clamps at zero rather than recording a negative
   * supply: the operation happened, and a cache that was already behind reality is
   * not a reason to write nonsense.
   */
  private async _applySupplyDelta(
    tokenId: string,
    deltaBaseUnits: string,
    direction: "add" | "subtract"
  ): Promise<void> {
    const expression =
      direction === "add"
        ? "(COALESCE(total_supply_cached, '0')::numeric + ?::numeric)::text"
        : "GREATEST(COALESCE(total_supply_cached, '0')::numeric - ?::numeric, 0)::text";
    const now = new Date().toISOString();
    const tenant = this.tenantMutationScope();
    await this.db
      .prepare(
        `UPDATE issued_tokens
         SET total_supply_cached = ${expression},
             total_supply_updated_at = ?,
             updated_at = ?
         WHERE id = ?${tenant.clause}`
      )
      .bind(deltaBaseUnits, now, now, tokenId, ...tenant.values)
      .run();
  }

  /**
   * Reconcile the recorded supply against what the mint itself reports.
   *
   * The chain is the authority on what has settled — but not on what is about to.
   * A mint SDP admits is counted before it can reach the chain
   * (`reserveMintSupply`) and the mint account will not show it until it lands, so
   * overwriting inside that window put the record back below the reservation and
   * handed the same headroom to the next mint: both then settled, together above
   * the cap.
   *
   * What that protects is a quantity, not a flag. The floor a refresh must respect
   * is the on-chain total plus what the mints that could still land could still
   * add — each unsettled mint row carries its amount — and the record may come
   * down to that floor at once. A hold that only asked "is anything in flight?"
   * kept everything above the floor too, and on a busy token the window never
   * reopened: reservations whose transactions had expired unsubmittable leaked
   * forever, until the cap refused mints for supply that did not exist. Upward is
   * never held — an on-chain total above the record came from outside SDP and has
   * to start refusing mints at once. One statement, so a mint cannot start between
   * the check and the write.
   *
   * "Could still land" deliberately includes mints recorded as failed: a send that
   * fails ambiguously (a timeout on a transaction the cluster accepted anyway) keeps
   * its reservation because nobody can yet say otherwise, and the age bound is what
   * finally settles it — after which this reads the answer off the chain. A mint
   * that already landed counts twice for the length of the window (once in the
   * chain total, once as its row); the floor is deliberately an upper bound, and
   * the excess falls away as rows settle or age out.
   */
  async setSupplyFromBaseUnits(tokenId: string, supplyBaseUnits: string): Promise<Token> {
    if (!/^\d+$/.test(supplyBaseUnits)) {
      throw new Error("INVALID_SUPPLY");
    }

    const now = new Date().toISOString();
    const tenantRead = this.tenantTokenScope("tok");
    const tenantWrite = this.tenantTokenScope("issued_tokens");
    const since = new Date(Date.now() - MINT_IN_FLIGHT_WINDOW_MS).toISOString();
    const applied = await this.db
      .prepare(
        `WITH live AS (
           SELECT COALESCE(SUM(CASE
             WHEN t.operation_params::jsonb ->> 'amount' ~ '^\\d+(\\.\\d+)?$'
               THEN trunc(
                 (t.operation_params::jsonb ->> 'amount')::numeric
                   * (10::numeric ^ tok.decimals),
                 0
               )
             ELSE 0
           END), 0) AS reserved
           FROM issuance_transactions t
           JOIN issued_tokens tok ON tok.id = t.token_id
           WHERE t.token_id = ? AND t.type = 'mint'
             AND t.status IN ('pending', 'processing', 'failed')
             AND t.updated_at >= ?
         ),
         resolved AS (
           SELECT
             GREATEST(
               ?::numeric,
               LEAST(
                 COALESCE(tok.total_supply_cached, '0')::numeric,
                 ?::numeric + live.reserved
               )
             ) AS supply,
             live.reserved AS reserved
           FROM issued_tokens tok, live
           WHERE tok.id = ?${tenantRead.clause}
         )
         UPDATE issued_tokens
         SET total_supply_cached = resolved.supply::text,
             total_supply_updated_at = CASE
               WHEN resolved.supply = ?::numeric THEN ?
               ELSE issued_tokens.total_supply_updated_at
             END,
             updated_at = ?
         FROM resolved
         WHERE issued_tokens.id = ?${tenantWrite.clause}
         RETURNING issued_tokens.total_supply_cached, resolved.reserved::text AS live_reserved`
      )
      .bind(
        tokenId,
        since,
        supplyBaseUnits,
        supplyBaseUnits,
        tokenId,
        ...tenantRead.values,
        supplyBaseUnits,
        now,
        now,
        tokenId,
        ...tenantWrite.values
      )
      .first<{ total_supply_cached: string; live_reserved: string }>();

    if (!applied) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    // Held above the reading, so the figure on screen is SDP's own count and its
    // "as of" stamp stays where it was — the next refresh past the window is what
    // finishes the reconciliation.
    if (applied && applied.total_supply_cached !== supplyBaseUnits) {
      getLogger().warn(
        {
          event: "token_supply_refresh_deferred",
          tokenId,
          onChainSupplyBaseUnits: supplyBaseUnits,
          recordedSupplyBaseUnits: applied.total_supply_cached,
          liveReservedBaseUnits: applied.live_reserved,
        },
        "SDP's recorded supply is above the on-chain total by what in-flight mints could still add; kept the difference so no reservation is handed out twice. Refresh again once they settle."
      );
    }

    // Reservations keep SDP's own mints under the cap, so a total above it means
    // supply came from somewhere SDP does not admit — a mint authority used
    // outside the platform.
    // Worth saying out loud: the only other trace is a supply figure quietly larger
    // than the cap beside it, and no further mints will be admitted.
    if (updated.maxSupply) {
      const maxSupply = parseDecimalAmount(updated.maxSupply, updated.decimals);
      if (BigInt(supplyBaseUnits) > maxSupply) {
        getLogger().warn(
          {
            event: "token_supply_exceeds_max_supply",
            tokenId,
            onChainSupplyBaseUnits: supplyBaseUnits,
            maxSupplyBaseUnits: maxSupply.toString(),
          },
          "On-chain supply is above the token's configured max supply; it was not minted through SDP's cap. No further mints are admitted until the cap is raised."
        );
      }
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Token Transactions
  // ═══════════════════════════════════════════════════════════════════════════

  async createTransaction(input: CreateTokenTransactionInput): Promise<CreateTransactionResult> {
    if (this.tenantScope) {
      this.assertTenantOptions({
        organizationId: input.organizationId,
        projectId: this.tenantScope.projectId,
      });
      await this.assertTokenInTenant(input.tokenId);
    }

    if (input.idempotencyKey && !input.idempotencyFingerprint) {
      throw badRequest("Missing idempotency fingerprint for idempotency key");
    }

    if (input.idempotencyKey) {
      const existing = await this.findTransactionByIdempotency(
        input.organizationId,
        input.idempotencyKey
      );
      if (existing) {
        if (existing.idempotencyFingerprint === input.idempotencyFingerprint) {
          return { transaction: existing, replayed: true };
        }
        throw new AppError(
          "CONFLICT",
          "Idempotency key already used with different request payload"
        );
      }
    }

    const id = `ttx_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const tx: TokenTransaction = {
      id,
      tokenId: input.tokenId,
      organizationId: input.organizationId,
      type: input.type,
      status: "pending",
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyFingerprint: input.idempotencyFingerprint ?? null,
      signature: null,
      serializedTx: input.serializedTx ?? null,
      params: input.params,
      slot: null,
      blockTime: null,
      fee: null,
      error: null,
      initiatedByKeyId: input.initiatedByKeyId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db
        .prepare(
          `INSERT INTO issuance_transactions (
          id, token_id, organization_id, type, status, idempotency_key, idempotency_fingerprint,
          signature, serialized_tx, operation_params, slot, block_time, fee, error, initiated_by_key_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          tx.id,
          tx.tokenId,
          tx.organizationId,
          tx.type,
          tx.status,
          tx.idempotencyKey ?? null,
          tx.idempotencyFingerprint ?? null,
          tx.signature,
          tx.serializedTx,
          JSON.stringify(tx.params),
          tx.slot,
          tx.blockTime,
          tx.fee,
          tx.error,
          tx.initiatedByKeyId,
          tx.createdAt,
          tx.updatedAt
        )
        .run();
    } catch (error) {
      if (
        input.idempotencyKey &&
        input.idempotencyFingerprint &&
        error instanceof Error &&
        error.message.includes("UNIQUE")
      ) {
        const existing = await this.findTransactionByIdempotency(
          input.organizationId,
          input.idempotencyKey
        );

        if (existing) {
          if (existing.idempotencyFingerprint === input.idempotencyFingerprint) {
            return { transaction: existing, replayed: true };
          }

          throw new AppError(
            "CONFLICT",
            "Idempotency key already used with different request payload"
          );
        }
      }

      throw error;
    }

    await this.insertTransactionStatus(tx.id, tx.status, tx.createdAt);

    return { transaction: tx, replayed: false };
  }

  /**
   * Update a token transaction
   */
  async updateTransaction(
    txId: string,
    input: UpdateTokenTransactionInput
  ): Promise<TokenTransaction> {
    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.status !== undefined) {
      updates.push("status = ?");
      values.push(input.status);
    }

    if (input.signature !== undefined) {
      updates.push("signature = ?");
      values.push(input.signature);
    }

    if (input.slot !== undefined) {
      updates.push("slot = ?");
      values.push(input.slot);
    }

    if (input.blockTime !== undefined) {
      updates.push("block_time = ?");
      values.push(input.blockTime);
    }

    if (input.fee !== undefined) {
      updates.push("fee = ?");
      values.push(input.fee);
    }

    if (input.error !== undefined) {
      updates.push("error = ?");
      values.push(input.error);
    }

    if (input.serializedTx !== undefined) {
      updates.push("serialized_tx = ?");
      values.push(input.serializedTx);
    }

    if (input.params !== undefined) {
      updates.push("operation_params = ?");
      values.push(JSON.stringify(input.params));
    }

    updates.push("updated_at = ?");
    values.push(now);
    values.push(txId);

    const tenant = this.tenantTokenScope("tenant_token");
    const rowsAffected = await this.db
      .prepare(
        `UPDATE issuance_transactions
         SET ${updates.join(", ")}
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM issued_tokens tenant_token
             WHERE tenant_token.id = issuance_transactions.token_id${tenant.clause}
           )`
      )
      .bind(...values, ...tenant.values)
      .run();

    if (rowsAffected === 0) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    if (input.status) {
      await this.insertTransactionStatus(txId, input.status, now);
    }

    const transaction = await this.getTransaction(txId);
    if (!transaction) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    return transaction;
  }

  /**
   * Get a token transaction by ID
   */
  async getTransaction(txId: string): Promise<TokenTransaction | null> {
    const tenant = this.tenantTokenScope("tenant_token");
    const row = await this.db
      .prepare(
        `SELECT tx.id, tx.token_id, tx.organization_id, tx.type, tx.status, tx.idempotency_key,
                tx.idempotency_fingerprint, tx.signature, tx.serialized_tx, tx.operation_params,
                tx.slot, tx.block_time, tx.fee, tx.error, tx.initiated_by_key_id,
                tx.created_at, tx.updated_at
         FROM issuance_transactions tx
         JOIN issued_tokens tenant_token ON tenant_token.id = tx.token_id
         WHERE tx.id = ?${tenant.clause}`
      )
      .bind(txId, ...tenant.values)
      .first<TokenTransactionRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToTransaction(row);
  }

  async findTransactionByIdempotency(
    organizationId: string,
    idempotencyKey: string
  ): Promise<TokenTransaction | null> {
    if (this.tenantScope) {
      this.assertTenantOptions({ organizationId, projectId: this.tenantScope.projectId });
    }
    const tenant = this.tenantTokenScope("tenant_token");
    const row = await this.db
      .prepare(
        `SELECT tx.id, tx.token_id, tx.organization_id, tx.type, tx.status, tx.idempotency_key,
                tx.idempotency_fingerprint, tx.signature, tx.serialized_tx, tx.operation_params,
                tx.slot, tx.block_time, tx.fee, tx.error, tx.initiated_by_key_id,
                tx.created_at, tx.updated_at
         FROM issuance_transactions tx
         JOIN issued_tokens tenant_token ON tenant_token.id = tx.token_id
         WHERE tx.organization_id = ? AND tx.idempotency_key = ?${tenant.clause}`
      )
      .bind(organizationId, idempotencyKey, ...tenant.values)
      .first<TokenTransactionRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToTransaction(row);
  }

  async listTokenTransactions(
    tokenId: string,
    options: {
      status?: TokenTransaction["status"];
      type?: TokenTransaction["type"];
      organizationId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ transactions: TokenTransaction[]; total: number }> {
    const { status, type, organizationId, limit = 50, offset = 0 } = options;

    await this.assertTokenInTenant(tokenId);
    if (organizationId && this.tenantScope) {
      this.assertTenantOptions({ organizationId, projectId: this.tenantScope.projectId });
    }

    let countQuery = "SELECT COUNT(*) as count FROM issuance_transactions WHERE token_id = ?";
    let selectQuery = `SELECT id, token_id, organization_id, type, status, idempotency_key, idempotency_fingerprint,
              signature, serialized_tx, operation_params, slot, block_time, fee, error, initiated_by_key_id,
              created_at, updated_at
       FROM issuance_transactions WHERE token_id = ?`;
    const params: (string | number)[] = [tokenId];

    if (organizationId) {
      countQuery += " AND organization_id = ?";
      selectQuery += " AND organization_id = ?";
      params.push(organizationId);
    }

    if (status) {
      countQuery += " AND status = ?";
      selectQuery += " AND status = ?";
      params.push(status);
    }

    if (type) {
      countQuery += " AND type = ?";
      selectQuery += " AND type = ?";
      params.push(type);
    }

    // id breaks ties so rows sharing a created_at can't shuffle between pages
    // (same stable ordering as listAllowlistEntries and the org-wide list).
    selectQuery += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";

    const countResult = await this.db
      .prepare(countQuery)
      .bind(...params)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(selectQuery)
      .bind(...params, limit, offset)
      .all<TokenTransactionRow>();

    return {
      transactions: result.results.map((row) => this.mapRowToTransaction(row)),
      total: countResult?.count ?? 0,
    };
  }

  async listTransactionTokenCandidates(options: {
    organizationId: string;
    projectId?: string | null;
  }): Promise<Array<{ tokenId: string; mintAddress: string }>> {
    this.assertTenantOptions(options);
    const params: string[] = [options.organizationId];
    let query = `
      SELECT id, mint_address
      FROM issued_tokens
      WHERE organization_id = ?
        AND mint_address IS NOT NULL
    `;

    if (options.projectId) {
      query += " AND project_id = ?";
      params.push(options.projectId);
    }

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all<{ id: string; mint_address: string | null }>();

    return result.results
      .filter(
        (row): row is { id: string; mint_address: string } =>
          typeof row.mint_address === "string" && row.mint_address.length > 0
      )
      .map((row) => ({ tokenId: row.id, mintAddress: row.mint_address }));
  }

  async listTransactions(options: {
    organizationId: string;
    projectId?: string | null;
    types?: TokenTransactionType[];
    status?: TokenTransactionStatus;
    walletScope?: WalletTransactionScope;
    limit?: number;
    offset?: number;
  }): Promise<{ transactions: TokenTransactionListItem[]; total: number }> {
    this.assertTenantOptions(options);
    const {
      organizationId,
      projectId,
      types = [],
      status,
      walletScope,
      limit = 50,
      offset = 0,
    } = options;
    const distinctTypes = Array.from(new Set(types));
    const params: (string | number)[] = [organizationId];
    const conditions = ["tx.organization_id = ?"];
    const publicKeys = Array.from(new Set(walletScope?.publicKeys ?? []));
    const tokenAccounts = walletScope?.tokenAccounts ?? [];

    let cte = "";
    const cteParams: string[] = [];
    if (tokenAccounts.length > 0) {
      const values = tokenAccounts.map(() => "(?, ?)").join(", ");

      for (const match of tokenAccounts) {
        cteParams.push(match.tokenId, match.tokenAccount);
      }

      cte = `WITH wallet_token_accounts(token_id, token_account) AS (VALUES ${values}) `;
    }

    if (projectId) {
      conditions.push("t.project_id = ?");
      params.push(projectId);
    }

    if (status) {
      conditions.push("tx.status = ?");
      params.push(status);
    }

    if (distinctTypes.length > 0) {
      conditions.push(`tx.type IN (${distinctTypes.map(() => "?").join(", ")})`);
      params.push(...distinctTypes);
    }

    if (walletScope) {
      const candidateTypes =
        distinctTypes.length > 0
          ? distinctTypes
          : (Object.keys(WALLET_TRANSACTION_MATCH_CONFIG) as TokenTransactionType[]);
      const walletTypeConditions: string[] = [];

      for (const type of candidateTypes) {
        const config = WALLET_TRANSACTION_MATCH_CONFIG[type];
        const publicKeyConditions =
          publicKeys.length > 0
            ? config.publicKeyFields.map(
                (key) =>
                  // operation_params is TEXT; a malformed row would abort the whole
                  // scan on the ::jsonb cast, so guard it with pg_input_is_valid
                  // (PG16+) inside a CASE (WHERE AND is not short-circuited).
                  `CASE WHEN pg_input_is_valid(tx.operation_params, 'jsonb') THEN tx.operation_params::jsonb ->> '${key}' IN (${publicKeys.map(() => "?").join(", ")}) ELSE false END`
              )
            : [];
        const tokenAccountConditions =
          tokenAccounts.length > 0
            ? config.tokenAccountFields.map(
                // Same guard as above: the CASE keeps the ::jsonb cast (inside the
                // EXISTS) from running on a malformed operation_params row.
                (key) => `CASE WHEN pg_input_is_valid(tx.operation_params, 'jsonb') THEN EXISTS (
                  SELECT 1
                  FROM wallet_token_accounts wta
                  WHERE wta.token_id = tx.token_id
                    AND wta.token_account = (tx.operation_params::jsonb ->> '${key}')
                ) ELSE false END`
              )
            : [];
        const matchConditions = [...publicKeyConditions, ...tokenAccountConditions];

        if (matchConditions.length === 0) {
          continue;
        }

        walletTypeConditions.push(`(tx.type = ? AND (${matchConditions.join(" OR ")}))`);
        params.push(type);
        for (const _field of config.publicKeyFields) {
          params.push(...publicKeys);
        }
      }

      conditions.push(
        walletTypeConditions.length > 0 ? `(${walletTypeConditions.join(" OR ")})` : "FALSE"
      );
    }

    const fromClause = `
      FROM issuance_transactions tx
      JOIN issued_tokens t ON t.id = tx.token_id
    `;
    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    const countQuery = `${cte}SELECT COUNT(*) as count ${fromClause} ${whereClause}`;
    const selectQuery = `${cte}SELECT
        tx.id,
        tx.token_id,
        tx.organization_id,
        tx.type,
        tx.status,
        tx.idempotency_key,
        tx.idempotency_fingerprint,
        tx.signature,
        tx.serialized_tx,
        tx.operation_params,
        tx.slot,
        tx.block_time,
        tx.fee,
        tx.error,
        tx.initiated_by_key_id,
        tx.created_at,
        tx.updated_at,
        t.name AS token_name,
        t.symbol AS token_symbol,
        t.mint_address AS token_mint_address
      ${fromClause}
      ${whereClause}
      ORDER BY tx.created_at DESC, tx.id DESC
      LIMIT ? OFFSET ?`;

    const countResult = await this.db
      .prepare(countQuery)
      .bind(...cteParams, ...params)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(selectQuery)
      .bind(...cteParams, ...params, limit, offset)
      .all<TokenTransactionListRow>();

    return {
      transactions: result.results.map((row) => ({
        token: {
          id: row.token_id,
          name: row.token_name,
          symbol: row.token_symbol,
          mintAddress: row.token_mint_address,
        },
        transaction: this.mapRowToTransaction(row),
      })),
      total: countResult?.count ?? 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // Allowlist Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add an address to the token allowlist.
   *
   * `initialStatus: "pending"` gives on-chain callers a durable intent record
   * before submission. A retry reuses that pending row; confirmed membership
   * is promoted with `activateAllowlistEntry`. Database-only callers keep the
   * default immediate `active` status.
   */
  async addAllowlistEntry(
    input: AddAllowlistInput
  ): Promise<{ entry: TokenAllowlistEntry; wasReactivated: boolean }> {
    await this.assertTokenInTenant(input.tokenId);
    const requestedStatus = input.initialStatus ?? "active";
    const existing = await this.db
      .prepare("SELECT id, status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(input.tokenId, input.address)
      .first<{ id: string; status: string }>();

    if (existing) {
      if (existing.status === "active") {
        throw new Error("ADDRESS_ALREADY_ALLOWLISTED");
      }
      const wasReactivated = existing.status === "revoked";
      await this.db
        .prepare(
          "UPDATE token_allowlists SET status = ?, revoked_at = NULL, label = ?, added_by = ? WHERE id = ?"
        )
        .bind(requestedStatus, input.label ?? null, input.addedBy, existing.id)
        .run();

      if (existing.status !== requestedStatus) {
        await this.insertAllowlistStatus(existing.id, requestedStatus, new Date().toISOString());
      }

      const entry = await this.getAllowlistEntry(existing.id);
      if (!entry) {
        throw new Error("ALLOWLIST_ENTRY_NOT_FOUND");
      }
      return { entry, wasReactivated };
    }

    const entry = await this.insertNewAllowlistEntry(input);
    return { entry, wasReactivated: false };
  }

  /**
   * Insert a fresh allowlist entry, refusing to touch existing rows.
   *
   * Unlike `addAllowlistEntry`, this never reactivates a `revoked` row.
   * Used by the mint auto-add sync, where reactivation would silently undo an
   * operator's KYC/compliance revocation if it landed between the top-level
   * status check and the insert (race window in `syncDestinationToOnChainAllowlist`).
   *
   * - Existing `active` row → throws `Error("ADDRESS_ALREADY_ALLOWLISTED")`
   *   (same as `addAllowlistEntry`, so caller race-handling stays uniform).
   * - Existing `revoked` row → throws `AppError("DESTINATION_REVOKED")`,
   *   so the mint short-circuits to 403 instead of silently un-revoking.
   */
  async addAllowlistEntryStrict(input: AddAllowlistInput): Promise<TokenAllowlistEntry> {
    await this.assertTokenInTenant(input.tokenId);
    const existing = await this.db
      .prepare("SELECT id, status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(input.tokenId, input.address)
      .first<{ id: string; status: string }>();

    if (existing) {
      if (existing.status === "revoked") {
        throw new AppError("DESTINATION_REVOKED");
      }
      throw new Error("ADDRESS_ALREADY_ALLOWLISTED");
    }

    return this.insertNewAllowlistEntry(input);
  }

  private async insertNewAllowlistEntry(input: AddAllowlistInput): Promise<TokenAllowlistEntry> {
    const id = `tal_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const entry: TokenAllowlistEntry = {
      id,
      tokenId: input.tokenId,
      address: input.address,
      label: input.label ?? null,
      status: input.initialStatus ?? "active",
      addedBy: input.addedBy,
      createdAt: now,
      revokedAt: null,
    };

    try {
      await this.db
        .prepare(
          `INSERT INTO token_allowlists (
            id, token_id, address, label,
            status, added_by, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          entry.id,
          entry.tokenId,
          entry.address,
          entry.label,
          entry.status,
          entry.addedBy,
          entry.createdAt,
          entry.revokedAt
        )
        .run();
    } catch (error) {
      // SELECT-then-INSERT is non-atomic on `UNIQUE(token_id, address)`: a
      // parallel caller can win the INSERT between our caller's SELECT and
      // this one. Map the Postgres unique-violation (SQLSTATE 23505) to the
      // same idempotent signal callers already handle for the "row was there
      // when we looked" case, instead of bubbling a raw DB error.
      if (isPostgresUniqueViolation(error)) {
        throw new Error("ADDRESS_ALREADY_ALLOWLISTED");
      }
      throw error;
    }

    await this.insertAllowlistStatus(entry.id, entry.status, entry.createdAt);

    return entry;
  }

  async getAllowlistEntry(entryId: string): Promise<TokenAllowlistEntry | null> {
    const tenant = this.tenantTokenScope("tenant_token");
    const row = await this.db
      .prepare(
        `SELECT allowlist.id, allowlist.token_id, allowlist.address, allowlist.label,
                allowlist.status, allowlist.added_by, allowlist.created_at, allowlist.revoked_at
         FROM token_allowlists allowlist
         JOIN issued_tokens tenant_token ON tenant_token.id = allowlist.token_id
         WHERE allowlist.id = ?${tenant.clause}`
      )
      .bind(entryId, ...tenant.values)
      .first<AllowlistRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToAllowlistEntry(row);
  }

  async listAllowlistEntries(
    tokenId: string,
    options: {
      status?: AllowlistEntryStatus;
      search?: string;
      label?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ entries: TokenAllowlistEntry[]; total: number }> {
    await this.assertTokenInTenant(tokenId);
    const { status = "active", search, label, limit = 50, offset = 0 } = options;

    // Shared WHERE for the data + count queries. Search is a contains-style
    // ILIKE over address + label backed by idx_token_allowlist_search_trgm;
    // label is an exact filter backed by idx_token_allowlist_token_status_label.
    const clauses = ["token_id = ?", "status = ?"];
    const filterValues: Array<string | number> = [tokenId, status];

    if (label !== undefined) {
      clauses.push("label = ?");
      filterValues.push(label);
    }

    if (search) {
      clauses.push("(address || ' ' || COALESCE(label, '')) ILIKE ? ESCAPE '\\'");
      filterValues.push(`%${escapeLikePattern(search)}%`);
    }

    const whereClause = clauses.join(" AND ");

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM token_allowlists WHERE ${whereClause}`)
      .bind(...filterValues)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(
        `SELECT id, token_id, address, label,
                status, added_by, created_at, revoked_at
         FROM token_allowlists
         WHERE ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...filterValues, limit, offset)
      .all<AllowlistRow>();

    return {
      entries: result.results.map((row) => this.mapRowToAllowlistEntry(row)),
      total: countResult?.count ?? 0,
    };
  }

  /**
   * List the distinct non-empty labels used on a token's control-list entries,
   * plus the unfiltered entry count. Feeds the compliance-tab label filter and
   * its "N entries" summary card now that the list itself is server-paged and
   * search-filtered (the list endpoint's total reflects the active filter, so
   * the summary count comes from here instead).
   */
  async listAllowlistLabels(
    tokenId: string,
    options: { status?: AllowlistEntryStatus } = {}
  ): Promise<{ labels: string[]; total: number }> {
    await this.assertTokenInTenant(tokenId);
    const { status = "active" } = options;

    const [labelsResult, countResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT DISTINCT label
           FROM token_allowlists
           WHERE token_id = ? AND status = ? AND label IS NOT NULL
           ORDER BY label`
        )
        .bind(tokenId, status)
        .all<{ label: string }>(),
      this.db
        .prepare("SELECT COUNT(*) as count FROM token_allowlists WHERE token_id = ? AND status = ?")
        .bind(tokenId, status)
        .first<{ count: number }>(),
    ]);

    return {
      labels: labelsResult.results.map((row) => row.label),
      total: countResult?.count ?? 0,
    };
  }

  async isAddressAllowed(tokenId: string, address: string): Promise<boolean> {
    await this.assertTokenInTenant(tokenId);
    const row = await this.db
      .prepare(
        "SELECT id FROM token_allowlists WHERE token_id = ? AND address = ? AND status = 'active'"
      )
      .bind(tokenId, address)
      .first<{ id: string }>();

    return row !== null;
  }

  /**
   * Look up an allowlist entry's status by address, regardless of state.
   * Returns `null` when no entry has ever existed (vs `"revoked"` when an
   * operator has explicitly removed the address).
   *
   * Used by the mint sync to distinguish a fresh address (auto-add) from one
   * the operator has revoked (must be re-added explicitly).
   */
  async getAllowlistEntryStatusByAddress(
    tokenId: string,
    address: string
  ): Promise<AllowlistEntryStatus | null> {
    await this.assertTokenInTenant(tokenId);
    const row = await this.db
      .prepare("SELECT status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(tokenId, address)
      .first<{ status: AllowlistEntryStatus }>();

    return row?.status ?? null;
  }

  async revokeAllowlistEntry(entryId: string): Promise<void> {
    const now = new Date().toISOString();
    const tenant = this.tenantTokenScope("tenant_token");
    const rowsAffected = await this.db
      .prepare(
        `UPDATE token_allowlists
         SET status = 'revoked', revoked_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM issued_tokens tenant_token
             WHERE tenant_token.id = token_allowlists.token_id${tenant.clause}
           )`
      )
      .bind(now, entryId, ...tenant.values)
      .run();

    if (rowsAffected === 0) {
      throw new Error("ALLOWLIST_ENTRY_NOT_FOUND");
    }

    await this.insertAllowlistStatus(entryId, "revoked", now);
  }

  async activateAllowlistEntry(entryId: string): Promise<TokenAllowlistEntry> {
    const now = new Date().toISOString();
    const tenant = this.tenantTokenScope("tenant_token");
    const rowsAffected = await this.db
      .prepare(
        `UPDATE token_allowlists
         SET status = 'active', revoked_at = NULL
         WHERE id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1
             FROM issued_tokens tenant_token
             WHERE tenant_token.id = token_allowlists.token_id${tenant.clause}
           )`
      )
      .bind(entryId, ...tenant.values)
      .run();

    if (rowsAffected > 0) {
      await this.insertAllowlistStatus(entryId, "active", now);
    }
    const entry = await this.getAllowlistEntry(entryId);
    if (!entry) {
      throw new Error("ALLOWLIST_ENTRY_NOT_FOUND");
    }
    return entry;
  }

  /**
   * Hard-delete an allowlist entry.
   *
   * For system-driven rollback of an entry this request just created — e.g. a
   * mint sync that inserted the DB row, then failed to write the on-chain ABL.
   * Distinct from `revokeAllowlistEntry`: the row is removed entirely so a
   * subsequent retry doesn't trip the revoked-entry guard with a status the
   * operator never set. The FK on `token_allowlist_statuses.allowlist_id` is
   * `ON DELETE CASCADE`, so status history rows are removed by the database.
   */
  async deleteAllowlistEntry(entryId: string): Promise<void> {
    const tenant = this.tenantTokenScope("tenant_token");
    const rowsAffected = await this.db
      .prepare(
        `DELETE FROM token_allowlists
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM issued_tokens tenant_token
             WHERE tenant_token.id = token_allowlists.token_id${tenant.clause}
           )`
      )
      .bind(entryId, ...tenant.values)
      .run();

    if (rowsAffected === 0) {
      throw new Error("ALLOWLIST_ENTRY_NOT_FOUND");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze Management
  // ═══════════════════════════════════════════════════════════════════════════

  async freezeAccount(input: FreezeAccountInput): Promise<FrozenAccount> {
    await this.assertTokenInTenant(input.tokenId);
    const existing = await this.db
      .prepare(
        `SELECT id, token_id, account_address, reason, frozen_at, frozen_by, unfrozen_at, unfrozen_by
         FROM frozen_accounts
         WHERE token_id = ? AND account_address = ?`
      )
      .bind(input.tokenId, input.accountAddress)
      .first<FrozenAccountRow>();

    if (existing?.unfrozen_at === null) {
      throw new Error("ACCOUNT_ALREADY_FROZEN");
    }

    const now = new Date().toISOString();
    const id = existing?.id ?? `frz_${crypto.randomUUID()}`;

    const frozenAccount: FrozenAccount = {
      id,
      tokenId: input.tokenId,
      accountAddress: input.accountAddress,
      reason: input.reason ?? null,
      frozenAt: now,
      frozenBy: input.frozenBy,
      unfrozenAt: null,
      unfrozenBy: null,
    };

    if (existing) {
      await this.db
        .prepare(
          `UPDATE frozen_accounts
           SET reason = ?, frozen_at = ?, frozen_by = ?, unfrozen_at = NULL, unfrozen_by = NULL
           WHERE id = ?`
        )
        .bind(
          frozenAccount.reason,
          frozenAccount.frozenAt,
          frozenAccount.frozenBy,
          frozenAccount.id
        )
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO frozen_accounts (
            id, token_id, account_address, reason, frozen_at, frozen_by, unfrozen_at, unfrozen_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          frozenAccount.id,
          frozenAccount.tokenId,
          frozenAccount.accountAddress,
          frozenAccount.reason,
          frozenAccount.frozenAt,
          frozenAccount.frozenBy,
          frozenAccount.unfrozenAt,
          frozenAccount.unfrozenBy
        )
        .run();
    }

    return frozenAccount;
  }

  /**
   * Unfreeze an account
   */
  async unfreezeAccount(
    tokenId: string,
    accountAddress: string,
    unfrozenBy: string
  ): Promise<FrozenAccount> {
    await this.assertTokenInTenant(tokenId);
    const row = await this.db
      .prepare(
        `SELECT id, token_id, account_address, reason, frozen_at, frozen_by, unfrozen_at, unfrozen_by
         FROM frozen_accounts
         WHERE token_id = ? AND account_address = ? AND unfrozen_at IS NULL`
      )
      .bind(tokenId, accountAddress)
      .first<FrozenAccountRow>();

    if (!row) {
      throw new Error("ACCOUNT_NOT_FROZEN");
    }

    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE frozen_accounts SET unfrozen_at = ?, unfrozen_by = ? WHERE id = ?")
      .bind(now, unfrozenBy, row.id)
      .run();

    return {
      id: row.id,
      tokenId: row.token_id,
      accountAddress: row.account_address,
      reason: row.reason,
      frozenAt: row.frozen_at,
      frozenBy: row.frozen_by,
      unfrozenAt: now,
      unfrozenBy,
    };
  }

  /**
   * Check if an account is frozen
   */
  async isAccountFrozen(tokenId: string, accountAddress: string): Promise<boolean> {
    await this.assertTokenInTenant(tokenId);
    const row = await this.db
      .prepare(
        "SELECT id FROM frozen_accounts WHERE token_id = ? AND account_address = ? AND unfrozen_at IS NULL"
      )
      .bind(tokenId, accountAddress)
      .first<{ id: string }>();

    return row !== null;
  }

  /**
   * Get the latest frozen account record for an address
   */
  async getFrozenAccount(
    tokenId: string,
    accountAddress: string,
    includeUnfrozen = false
  ): Promise<FrozenAccount | null> {
    await this.assertTokenInTenant(tokenId);
    const row = await this.db
      .prepare(
        `SELECT id, token_id, account_address, reason, frozen_at, frozen_by, unfrozen_at, unfrozen_by
         FROM frozen_accounts
         WHERE token_id = ? AND account_address = ? ${includeUnfrozen ? "" : "AND unfrozen_at IS NULL"}
         ORDER BY frozen_at DESC
         LIMIT 1`
      )
      .bind(tokenId, accountAddress)
      .first<FrozenAccountRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToFrozenAccount(row);
  }

  /**
   * List frozen accounts for a token
   */
  async listFrozenAccounts(
    tokenId: string,
    options: { includeUnfrozen?: boolean; limit?: number; offset?: number } = {}
  ): Promise<{ frozenAccounts: FrozenAccount[]; total: number }> {
    await this.assertTokenInTenant(tokenId);
    const { includeUnfrozen = false, limit = 50, offset = 0 } = options;

    const unfrozenFilter = includeUnfrozen ? "" : "AND unfrozen_at IS NULL";

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM frozen_accounts WHERE token_id = ? ${unfrozenFilter}`)
      .bind(tokenId)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(
        `SELECT id, token_id, account_address, reason, frozen_at, frozen_by, unfrozen_at, unfrozen_by
         FROM frozen_accounts
         WHERE token_id = ? ${unfrozenFilter}
         ORDER BY frozen_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(tokenId, limit, offset)
      .all<FrozenAccountRow>();

    return {
      frozenAccounts: result.results.map((row) => this.mapRowToFrozenAccount(row)),
      total: countResult?.count ?? 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Extension and Status Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async insertTokenExtensions(
    tokenId: string,
    extensions: TokenExtensionsConfig,
    createdAt: string
  ): Promise<void> {
    const entries = Object.entries(extensions).filter(
      ([, value]) => value !== undefined && value !== null && value !== false
    );

    if (!entries.length) {
      return;
    }

    const statements = entries.map(([extension, value]) =>
      this.db
        .prepare(
          `INSERT INTO issued_token_extensions (id, token_id, extension, config, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(`tex_${crypto.randomUUID()}`, tokenId, extension, JSON.stringify(value), createdAt)
    );

    await this.db.batch(statements);
  }

  private async setTokenExtension(
    tokenId: string,
    extension: string,
    value: unknown | null,
    createdAt: string
  ): Promise<void> {
    if (value === null) {
      await this.db
        .prepare("DELETE FROM issued_token_extensions WHERE token_id = ? AND extension = ?")
        .bind(tokenId, extension)
        .run();
      return;
    }

    const config = value === true ? null : JSON.stringify(value);

    await this.db
      .prepare(
        `INSERT INTO issued_token_extensions (id, token_id, extension, config, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token_id, extension) DO UPDATE SET config = excluded.config`
      )
      .bind(`tex_${crypto.randomUUID()}`, tokenId, extension, config, createdAt)
      .run();
  }

  private async getTokenExtensionState(tokenId: string): Promise<TokenExtensionState> {
    const result = await this.db
      .prepare(
        `SELECT extension, config
         FROM issued_token_extensions
         WHERE token_id = ?`
      )
      .bind(tokenId)
      .all<TokenExtensionRow>();

    return this.mapExtensionRows(result.results);
  }

  private async getExtensionStatesForTokens(
    tokenIds: string[]
  ): Promise<Map<string, TokenExtensionState>> {
    const map = new Map<string, TokenExtensionState>();

    if (tokenIds.length === 0) {
      return map;
    }

    const placeholders = tokenIds.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `SELECT token_id, extension, config
         FROM issued_token_extensions
         WHERE token_id IN (${placeholders})`
      )
      .bind(...tokenIds)
      .all<{ token_id: string; extension: string; config: string | null }>();

    const grouped = new Map<string, TokenExtensionRow[]>();
    for (const row of rows.results) {
      const list = grouped.get(row.token_id) ?? [];
      list.push({ extension: row.extension, config: row.config });
      grouped.set(row.token_id, list);
    }

    for (const [tokenId, groupRows] of grouped.entries()) {
      map.set(tokenId, this.mapExtensionRows(groupRows));
    }

    return map;
  }

  private mapExtensionRows(rows: TokenExtensionRow[]): TokenExtensionState {
    const extensions: Record<string, unknown> = {};
    let metadataAuthority: string | null = null;

    for (const row of rows) {
      if (row.extension === "metadataAuthority") {
        if (row.config !== null) {
          const parsed = parsePostgresJsonOr<unknown>(row.config, row.config);
          metadataAuthority = typeof parsed === "string" ? parsed : row.config;
        }
        continue;
      }

      if (row.config === null) {
        extensions[row.extension] = true;
        continue;
      }

      extensions[row.extension] = parsePostgresJsonOr<unknown>(row.config, row.config);
    }

    return {
      extensions: Object.keys(extensions).length > 0 ? (extensions as TokenExtensionsConfig) : null,
      metadataAuthority,
    };
  }

  private async insertTransactionStatus(
    transactionId: string,
    status: TokenTransactionStatus,
    changedAt: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO issuance_transaction_statuses (id, transaction_id, status, changed_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`its_${crypto.randomUUID()}`, transactionId, status, changedAt)
      .run();
  }

  private async insertAllowlistStatus(
    allowlistId: string,
    status: AllowlistEntryStatus,
    changedAt: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO token_allowlist_statuses (id, allowlist_id, status, changed_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`als_${crypto.randomUUID()}`, allowlistId, status, changedAt)
      .run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Row Mapping Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private mapRowToToken(row: TokenRow, extensionState: TokenExtensionState): Token {
    const totalSupply = formatDecimalAmount(row.total_supply_cached ?? "0", row.decimals);
    const maxSupply = row.max_supply ? formatDecimalAmount(row.max_supply, row.decimals) : null;

    return {
      id: row.id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      signingWalletId: row.signing_wallet_id,
      mintAddress: row.mint_address,
      mintAuthority: row.mint_authority,
      metadataAuthority:
        extensionState.metadataAuthority ?? row.metadata_authority ?? row.mint_authority,
      freezeAuthority: row.freeze_authority,
      ablListAddress: row.abl_list_address,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      description: row.description,
      uri: row.uri,
      imageUrl: row.image_url,
      template: (row.template ?? "custom") as TokenTemplate,
      extensions: extensionState.extensions,
      totalSupply,
      totalSupplyUpdatedAt: row.total_supply_updated_at,
      maxSupply,
      isMintable: row.is_mintable === 1,
      isFreezable: row.freeze_authority_enabled === 1,
      requiresAllowlist: row.allowlist_enabled === 1,
      status: row.status as TokenStatus,
      deployedAt: row.deployed_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRowToTransaction(row: TokenTransactionRow): TokenTransaction {
    const params = parsePostgresJsonOr<Record<string, unknown>>(row.operation_params, {});

    return {
      id: row.id,
      tokenId: row.token_id,
      organizationId: row.organization_id,
      type: row.type as TokenTransactionType,
      status: row.status as TokenTransactionStatus,
      idempotencyKey: row.idempotency_key,
      idempotencyFingerprint: row.idempotency_fingerprint,
      signature: row.signature,
      serializedTx: row.serialized_tx,
      params,
      slot: row.slot,
      blockTime: row.block_time,
      fee: row.fee,
      error: row.error,
      initiatedByKeyId: row.initiated_by_key_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRowToAllowlistEntry(row: AllowlistRow): TokenAllowlistEntry {
    return {
      id: row.id,
      tokenId: row.token_id,
      address: row.address,
      label: row.label,
      status: row.status as AllowlistEntryStatus,
      addedBy: row.added_by,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  private mapRowToFrozenAccount(row: FrozenAccountRow): FrozenAccount {
    return {
      id: row.id,
      tokenId: row.token_id,
      accountAddress: row.account_address,
      reason: row.reason,
      frozenAt: row.frozen_at,
      frozenBy: row.frozen_by,
      unfrozenAt: row.unfrozen_at,
      unfrozenBy: row.unfrozen_by,
    };
  }
}
