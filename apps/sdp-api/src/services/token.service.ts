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
  TokenTransactionStatus,
  TokenTransactionType,
} from "@sdp/types";
import { formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { AppError } from "@/lib/errors";

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
   * Get a token by ID
   */
  async getToken(tokenId: string): Promise<Token | null> {
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
    const existing = await this.getToken(tokenId);
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

    const updated = await this.getToken(tokenId);
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
    const existing = await this.getToken(tokenId);
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

    const updated = await this.getToken(tokenId);
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

    const updated = await this.getToken(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * Update token supply after mint/burn
   */
  async updateSupply(tokenId: string, delta: string, operation: "mint" | "burn"): Promise<void> {
    const token = await this.getToken(tokenId);
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

    const updated = await this.getToken(tokenId);
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
      throw new AppError("BAD_REQUEST", "Missing idempotency fingerprint for idempotency key");
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

  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // Allowlist Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add an address to the token allowlist
   */
  async addAllowlistEntry(input: AddAllowlistInput): Promise<TokenAllowlistEntry> {
    // Check for existing entry
    const existing = await this.db
      .prepare("SELECT id, status FROM token_allowlists WHERE token_id = ? AND address = ?")
      .bind(input.tokenId, input.address)
      .first<{ id: string; status: string }>();

    if (existing) {
      if (existing.status === "active") {
        throw new Error("ADDRESS_ALREADY_ALLOWLISTED");
      }
      // Reactivate revoked entry
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
      return entry;
    }

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
