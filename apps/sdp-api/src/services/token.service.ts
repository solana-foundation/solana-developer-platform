/**
 * Token Service
 *
 * Manages token issuance, including CRUD operations,
 * allowlist management, and freeze/unfreeze operations.
 */

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
import { formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { AppError, badRequest } from "@/lib/errors";

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
  /** Token template */
  template?: TokenTemplate;
  extensions?: TokenExtensionsConfig;
  maxSupply?: string;
  isMintable?: boolean;
  isFreezable?: boolean;
  requiresAllowlist?: boolean;
}

export interface UpdateTokenInput {
  name?: string;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
  status?: "active" | "paused";
  signingWalletId?: string | null;
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

// Postgres SQLSTATE for unique_violation. Used to translate races on
// `UNIQUE(...)` constraints into our domain error codes.
const POSTGRES_UNIQUE_VIOLATION = "23505";

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Service
// ═══════════════════════════════════════════════════════════════════════════

export class TokenService {
  constructor(private db: DatabaseClient) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Token CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new token
   */
  async createToken(input: CreateTokenInput): Promise<Token> {
    const id = `tok_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const decimals = input.decimals ?? 9;
    const maxSupplyBaseUnits = input.maxSupply
      ? parseDecimalAmount(input.maxSupply, decimals).toString()
      : null;

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
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                signing_wallet_id,
                abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                created_at, updated_at
         FROM issued_tokens WHERE id = ?`
      )
      .bind(tokenId)
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

  /**
   * Get a token by mint address
   */
  async getTokenByMint(mintAddress: string): Promise<Token | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
                signing_wallet_id,
                abl_list_address, name, symbol, decimals, description, uri, image_url, template,
                total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
                freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
                created_at, updated_at
         FROM issued_tokens WHERE mint_address = ?`
      )
      .bind(mintAddress)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    const extensionState = await this.getTokenExtensionState(row.id);
    return this.mapRowToToken(row, extensionState);
  }

  /**
   * List tokens for a project
   */
  async listTokens(
    projectId: string,
    options: { status?: TokenStatus; limit?: number; offset?: number } = {}
  ): Promise<{ tokens: Token[]; total: number }> {
    const { status, limit = 50, offset = 0 } = options;

    let countQuery = "SELECT COUNT(*) as count FROM issued_tokens WHERE project_id = ?";
    let selectQuery = `
      SELECT id, project_id, organization_id, mint_address, mint_authority, metadata_authority, freeze_authority,
             signing_wallet_id,
             abl_list_address, name, symbol, decimals, description, uri, image_url, template,
             total_supply_cached, total_supply_updated_at, max_supply, is_mintable,
             freeze_authority_enabled, allowlist_enabled, status, deployed_at, created_by,
             created_at, updated_at
      FROM issued_tokens WHERE project_id = ?
    `;
    const params: (string | number)[] = [projectId];

    if (status) {
      countQuery += " AND status = ?";
      selectQuery += " AND status = ?";
      params.push(status);
    }

    selectQuery += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    const countResult = await this.db
      .prepare(countQuery)
      .bind(...params)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(selectQuery)
      .bind(...params, limit, offset)
      .all<TokenRow>();

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
   * Update a token
   */
  async updateToken(tokenId: string, input: UpdateTokenInput): Promise<Token> {
    const existing = await this._getTokenById(tokenId);
    if (!existing) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
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

    if (updates.length === 0) {
      return existing;
    }

    updates.push("updated_at = ?");
    values.push(now);
    values.push(tokenId);

    await this.db
      .prepare(`UPDATE issued_tokens SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
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

      await this.db
        .prepare(`UPDATE issued_tokens SET ${fields.join(", ")} WHERE id = ?`)
        .bind(...values)
        .run();
    }

    if (updates.permanentDelegate !== undefined) {
      if (fields.length === 0) {
        await this.db
          .prepare("UPDATE issued_tokens SET updated_at = ? WHERE id = ?")
          .bind(now, tokenId)
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
   * Set token as deployed with mint address and optional ABL list
   */
  async setTokenDeployed(
    tokenId: string,
    mintAddress: string,
    mintAuthority: string,
    freezeAuthority: string | null,
    ablListAddress?: string | null
  ): Promise<Token> {
    const now = new Date().toISOString();

    await this.db
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
         WHERE id = ?`
      )
      .bind(
        mintAddress,
        mintAuthority,
        mintAuthority,
        freezeAuthority,
        ablListAddress ?? null,
        now,
        now,
        tokenId
      )
      .run();

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * Update token supply after mint/burn
   */
  async updateSupply(tokenId: string, delta: string, operation: "mint" | "burn"): Promise<void> {
    const token = await this._getTokenById(tokenId);
    if (!token) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const currentSupply = parseDecimalAmount(token.totalSupply, token.decimals);
    const deltaAmount = parseDecimalAmount(delta, token.decimals);
    let newSupply: bigint;

    if (operation === "mint") {
      newSupply = currentSupply + deltaAmount;

      // Check max supply
      if (token.maxSupply) {
        const maxSupply = parseDecimalAmount(token.maxSupply, token.decimals);
        if (newSupply > maxSupply) {
          throw new Error("MAX_SUPPLY_EXCEEDED");
        }
      }
    } else {
      newSupply = currentSupply - deltaAmount;
      if (newSupply < 0n) {
        throw new Error("INSUFFICIENT_SUPPLY");
      }
    }

    const now = new Date().toISOString();
    await this.db
      .prepare(
        "UPDATE issued_tokens SET total_supply_cached = ?, total_supply_updated_at = ?, updated_at = ? WHERE id = ?"
      )
      .bind(newSupply.toString(), now, now, tokenId)
      .run();
  }

  /**
   * Set token supply directly from a base-units on-chain value.
   */
  async setSupplyFromBaseUnits(tokenId: string, supplyBaseUnits: string): Promise<Token> {
    if (!/^\d+$/.test(supplyBaseUnits)) {
      throw new Error("INVALID_SUPPLY");
    }

    const now = new Date().toISOString();
    await this.db
      .prepare(
        "UPDATE issued_tokens SET total_supply_cached = ?, total_supply_updated_at = ?, updated_at = ? WHERE id = ?"
      )
      .bind(supplyBaseUnits, now, now, tokenId)
      .run();

    const updated = await this._getTokenById(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Token Transactions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a token transaction record
   */
  async createTransaction(input: CreateTokenTransactionInput): Promise<CreateTransactionResult> {
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

    if (input.params !== undefined) {
      updates.push("operation_params = ?");
      values.push(JSON.stringify(input.params));
    }

    updates.push("updated_at = ?");
    values.push(now);
    values.push(txId);

    await this.db
      .prepare(`UPDATE issuance_transactions SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    if (input.status) {
      await this.insertTransactionStatus(txId, input.status, now);
    }

    const row = await this.db
      .prepare(
        `SELECT id, token_id, organization_id, type, status, idempotency_key, idempotency_fingerprint,
                signature, serialized_tx, operation_params, slot, block_time, fee, error, initiated_by_key_id,
                created_at, updated_at
         FROM issuance_transactions WHERE id = ?`
      )
      .bind(txId)
      .first<TokenTransactionRow>();

    if (!row) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    return this.mapRowToTransaction(row);
  }

  /**
   * Get a token transaction by ID
   */
  async getTransaction(txId: string): Promise<TokenTransaction | null> {
    const row = await this.db
      .prepare(
        `SELECT id, token_id, organization_id, type, status, idempotency_key, idempotency_fingerprint,
                signature, serialized_tx, operation_params, slot, block_time, fee, error,
                initiated_by_key_id, created_at, updated_at
         FROM issuance_transactions WHERE id = ?`
      )
      .bind(txId)
      .first<TokenTransactionRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToTransaction(row);
  }

  /**
   * Find a token transaction by organization + idempotency key
   */
  async findTransactionByIdempotency(
    organizationId: string,
    idempotencyKey: string
  ): Promise<TokenTransaction | null> {
    const row = await this.db
      .prepare(
        `SELECT id, token_id, organization_id, type, status, idempotency_key, idempotency_fingerprint,
                signature, serialized_tx, operation_params, slot, block_time, fee, error, initiated_by_key_id,
                created_at, updated_at
         FROM issuance_transactions
         WHERE organization_id = ? AND idempotency_key = ?`
      )
      .bind(organizationId, idempotencyKey)
      .first<TokenTransactionRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToTransaction(row);
  }

  /**
   * List transactions for a token
   */
  async listTokenTransactions(
    tokenId: string,
    options: {
      status?: TokenTransaction["status"];
      organizationId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ transactions: TokenTransaction[]; total: number }> {
    const { status, organizationId, limit = 50, offset = 0 } = options;

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

    selectQuery += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

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
                  `tx.operation_params::jsonb ->> '${key}' IN (${publicKeys.map(() => "?").join(", ")})`
              )
            : [];
        const tokenAccountConditions =
          tokenAccounts.length > 0
            ? config.tokenAccountFields.map(
                (key) => `EXISTS (
                  SELECT 1
                  FROM wallet_token_accounts wta
                  WHERE wta.token_id = tx.token_id
                    AND wta.token_account = (tx.operation_params::jsonb ->> '${key}')
                )`
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
   * Returns `{ entry, wasReactivated }`. `wasReactivated` is `true` when this
   * call promoted a previously-revoked row back to `active` (vs. inserting a
   * fresh row). Callers rolling back after a downstream on-chain failure need
   * this to choose between `deleteAllowlistEntry` (fresh row → hard-delete)
   * and `revokeAllowlistEntry` (reactivated row → restore the prior `revoked`
   * state, preserving the operator's original revocation record).
   */
  async addAllowlistEntry(
    input: AddAllowlistInput
  ): Promise<{ entry: TokenAllowlistEntry; wasReactivated: boolean }> {
    const existing = await this.db
      .prepare("SELECT id, status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(input.tokenId, input.address)
      .first<{ id: string; status: string }>();

    if (existing) {
      if (existing.status === "active") {
        throw new Error("ADDRESS_ALREADY_ALLOWLISTED");
      }
      // Reactivate revoked entry — operator-initiated re-add.
      await this.db
        .prepare(
          "UPDATE token_allowlists SET status = 'active', revoked_at = NULL, label = ?, added_by = ? WHERE id = ?"
        )
        .bind(input.label ?? null, input.addedBy, existing.id)
        .run();

      await this.insertAllowlistStatus(existing.id, "active", new Date().toISOString());

      const entry = await this.getAllowlistEntry(existing.id);
      if (!entry) {
        throw new Error("ALLOWLIST_ENTRY_NOT_FOUND");
      }
      return { entry, wasReactivated: true };
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
      status: "active",
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

  /**
   * Get an allowlist entry by ID
   */
  async getAllowlistEntry(entryId: string): Promise<TokenAllowlistEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT id, token_id, address, label,
                status, added_by, created_at, revoked_at
         FROM token_allowlists WHERE id = ?`
      )
      .bind(entryId)
      .first<AllowlistRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToAllowlistEntry(row);
  }

  /**
   * List allowlist entries for a token
   */
  async listAllowlistEntries(
    tokenId: string,
    options: { status?: AllowlistEntryStatus; limit?: number; offset?: number } = {}
  ): Promise<{ entries: TokenAllowlistEntry[]; total: number }> {
    const { status = "active", limit = 50, offset = 0 } = options;

    const countResult = await this.db
      .prepare("SELECT COUNT(*) as count FROM token_allowlists WHERE token_id = ? AND status = ?")
      .bind(tokenId, status)
      .first<{ count: number }>();

    const result = await this.db
      .prepare(
        `SELECT id, token_id, address, label,
                status, added_by, created_at, revoked_at
         FROM token_allowlists
         WHERE token_id = ? AND status = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(tokenId, status, limit, offset)
      .all<AllowlistRow>();

    return {
      entries: result.results.map((row) => this.mapRowToAllowlistEntry(row)),
      total: countResult?.count ?? 0,
    };
  }

  /**
   * Check if an address is on the allowlist
   */
  async isAddressAllowed(tokenId: string, address: string): Promise<boolean> {
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
  ): Promise<"active" | "revoked" | null> {
    const row = await this.db
      .prepare("SELECT status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(tokenId, address)
      .first<{ status: "active" | "revoked" }>();

    return row?.status ?? null;
  }

  /**
   * Revoke an allowlist entry
   */
  async revokeAllowlistEntry(entryId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE token_allowlists SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .bind(now, entryId)
      .run();

    await this.insertAllowlistStatus(entryId, "revoked", now);
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
    await this.db.prepare("DELETE FROM token_allowlists WHERE id = ?").bind(entryId).run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Freeze an account
   */
  async freezeAccount(input: FreezeAccountInput): Promise<FrozenAccount> {
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
          try {
            const parsed = JSON.parse(row.config) as unknown;
            metadataAuthority = typeof parsed === "string" ? parsed : row.config;
          } catch {
            metadataAuthority = row.config;
          }
        }
        continue;
      }

      if (row.config === null) {
        extensions[row.extension] = true;
        continue;
      }

      try {
        extensions[row.extension] = JSON.parse(row.config) as unknown;
      } catch {
        extensions[row.extension] = row.config;
      }
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
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.operation_params) as Record<string, unknown>;
    } catch {
      params = {};
    }

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
