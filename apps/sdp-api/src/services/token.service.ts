/**
 * Token Service
 *
 * Manages token issuance, including CRUD operations,
 * allowlist management, and freeze/unfreeze operations.
 */

import type {
  AllowlistEntryStatus,
  FrozenAccount,
  KycStatus,
  Token,
  TokenAllowlistEntry,
  TokenExtensionsConfig,
  TokenStatus,
  TokenTransaction,
  TokenTransactionStatus,
  TokenTransactionType,
} from "@sdp/types";

// ═══════════════════════════════════════════════════════════════════════════
// Input Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateTokenInput {
  projectId: string;
  organizationId: string;
  createdBy: string;
  name: string;
  symbol: string;
  decimals?: number;
  description?: string;
  uri?: string;
  imageUrl?: string;
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
  initiatedByKeyId?: string;
}

export interface UpdateTokenTransactionInput {
  status?: TokenTransactionStatus;
  signature?: string;
  slot?: number;
  blockTime?: number;
  fee?: number;
  error?: string;
}

export interface AddAllowlistInput {
  tokenId: string;
  address: string;
  addedBy: string;
  label?: string;
  kycStatus?: KycStatus;
  kycProvider?: string;
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
  mint_address: string | null;
  mint_authority: string | null;
  freeze_authority: string | null;
  name: string;
  symbol: string;
  decimals: number;
  description: string | null;
  uri: string | null;
  image_url: string | null;
  extensions: string | null;
  total_supply: string;
  max_supply: string | null;
  is_mintable: number;
  is_freezable: number;
  requires_allowlist: number;
  status: string;
  deployed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface TokenTransactionRow {
  id: string;
  token_id: string;
  organization_id: string;
  type: string;
  status: string;
  signature: string | null;
  serialized_tx: string | null;
  params: string;
  slot: number | null;
  block_time: number | null;
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
  kyc_status: string;
  kyc_provider: string | null;
  kyc_verified_at: string | null;
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
  constructor(private db: D1Database) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Token CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new token
   */
  async createToken(input: CreateTokenInput): Promise<Token> {
    const id = `tok_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const token: Token = {
      id,
      projectId: input.projectId,
      organizationId: input.organizationId,
      mintAddress: null,
      mintAuthority: null,
      freezeAuthority: null,
      name: input.name,
      symbol: input.symbol,
      decimals: input.decimals ?? 9,
      description: input.description ?? null,
      uri: input.uri ?? null,
      imageUrl: input.imageUrl ?? null,
      extensions: input.extensions ?? null,
      totalSupply: "0",
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
        `INSERT INTO tokens (
          id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
          name, symbol, decimals, description, uri, image_url, extensions,
          total_supply, max_supply, is_mintable, is_freezable, requires_allowlist,
          status, deployed_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        token.id,
        token.projectId,
        token.organizationId,
        token.mintAddress,
        token.mintAuthority,
        token.freezeAuthority,
        token.name,
        token.symbol,
        token.decimals,
        token.description,
        token.uri,
        token.imageUrl,
        token.extensions ? JSON.stringify(token.extensions) : null,
        token.totalSupply,
        token.maxSupply,
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

    return token;
  }

  /**
   * Get a token by ID
   */
  async getToken(tokenId: string): Promise<Token | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
                name, symbol, decimals, description, uri, image_url, extensions,
                total_supply, max_supply, is_mintable, is_freezable, requires_allowlist,
                status, deployed_at, created_by, created_at, updated_at
         FROM tokens WHERE id = ?`
      )
      .bind(tokenId)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToToken(row);
  }

  /**
   * Get a token by mint address
   */
  async getTokenByMint(mintAddress: string): Promise<Token | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
                name, symbol, decimals, description, uri, image_url, extensions,
                total_supply, max_supply, is_mintable, is_freezable, requires_allowlist,
                status, deployed_at, created_by, created_at, updated_at
         FROM tokens WHERE mint_address = ?`
      )
      .bind(mintAddress)
      .first<TokenRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToToken(row);
  }

  /**
   * List tokens for a project
   */
  async listTokens(
    projectId: string,
    options: { status?: TokenStatus; limit?: number; offset?: number } = {}
  ): Promise<{ tokens: Token[]; total: number }> {
    const { status, limit = 50, offset = 0 } = options;

    let countQuery = "SELECT COUNT(*) as count FROM tokens WHERE project_id = ?";
    let selectQuery = `
      SELECT id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
             name, symbol, decimals, description, uri, image_url, extensions,
             total_supply, max_supply, is_mintable, is_freezable, requires_allowlist,
             status, deployed_at, created_by, created_at, updated_at
      FROM tokens WHERE project_id = ?
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

    return {
      tokens: result.results.map((row) => this.mapRowToToken(row)),
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
      .prepare(`UPDATE tokens SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await this.getToken(tokenId);
    if (!updated) {
      throw new Error("TOKEN_NOT_FOUND");
    }

    return updated;
  }

  /**
   * Set token as deployed with mint address
   */
  async setTokenDeployed(
    tokenId: string,
    mintAddress: string,
    mintAuthority: string,
    freezeAuthority: string | null
  ): Promise<Token> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `UPDATE tokens SET
          mint_address = ?,
          mint_authority = ?,
          freeze_authority = ?,
          status = 'active',
          deployed_at = ?,
          updated_at = ?
         WHERE id = ?`
      )
      .bind(mintAddress, mintAuthority, freezeAuthority, now, now, tokenId)
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

    const currentSupply = BigInt(token.totalSupply);
    const deltaAmount = BigInt(delta);
    let newSupply: bigint;

    if (operation === "mint") {
      newSupply = currentSupply + deltaAmount;

      // Check max supply
      if (token.maxSupply) {
        const maxSupply = BigInt(token.maxSupply);
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
      .prepare("UPDATE tokens SET total_supply = ?, updated_at = ? WHERE id = ?")
      .bind(newSupply.toString(), now, tokenId)
      .run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Token Transactions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a token transaction record
   */
  async createTransaction(input: CreateTokenTransactionInput): Promise<TokenTransaction> {
    const id = `ttx_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const tx: TokenTransaction = {
      id,
      tokenId: input.tokenId,
      organizationId: input.organizationId,
      type: input.type,
      status: "pending",
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

    await this.db
      .prepare(
        `INSERT INTO token_transactions (
          id, token_id, organization_id, type, status, signature, serialized_tx,
          params, slot, block_time, fee, error, initiated_by_key_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        tx.id,
        tx.tokenId,
        tx.organizationId,
        tx.type,
        tx.status,
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

    return tx;
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

    updates.push("updated_at = ?");
    values.push(now);
    values.push(txId);

    await this.db
      .prepare(`UPDATE token_transactions SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const row = await this.db
      .prepare(
        `SELECT id, token_id, organization_id, type, status, signature, serialized_tx,
                params, slot, block_time, fee, error, initiated_by_key_id, created_at, updated_at
         FROM token_transactions WHERE id = ?`
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
        `SELECT id, token_id, organization_id, type, status, signature, serialized_tx,
                params, slot, block_time, fee, error, initiated_by_key_id, created_at, updated_at
         FROM token_transactions WHERE id = ?`
      )
      .bind(txId)
      .first<TokenTransactionRow>();

    if (!row) {
      return null;
    }

    return this.mapRowToTransaction(row);
  }

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
          "UPDATE token_allowlists SET status = 'active', revoked_at = NULL, kyc_status = ?, kyc_provider = ?, label = ?, added_by = ? WHERE id = ?"
        )
        .bind(
          input.kycStatus ?? "none",
          input.kycProvider ?? null,
          input.label ?? null,
          input.addedBy,
          existing.id
        )
        .run();

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
      kycStatus: input.kycStatus ?? "none",
      kycProvider: input.kycProvider ?? null,
      kycVerifiedAt: null,
      status: "active",
      addedBy: input.addedBy,
      createdAt: now,
      revokedAt: null,
    };

    await this.db
      .prepare(
        `INSERT INTO token_allowlists (
          id, token_id, address, label, kyc_status, kyc_provider, kyc_verified_at,
          status, added_by, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.id,
        entry.tokenId,
        entry.address,
        entry.label,
        entry.kycStatus,
        entry.kycProvider,
        entry.kycVerifiedAt,
        entry.status,
        entry.addedBy,
        entry.createdAt,
        entry.revokedAt
      )
      .run();

    return entry;
  }

  /**
   * Get an allowlist entry by ID
   */
  async getAllowlistEntry(entryId: string): Promise<TokenAllowlistEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT id, token_id, address, label, kyc_status, kyc_provider, kyc_verified_at,
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
        `SELECT id, token_id, address, label, kyc_status, kyc_provider, kyc_verified_at,
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Freeze an account
   */
  async freezeAccount(input: FreezeAccountInput): Promise<FrozenAccount> {
    // Check if already frozen
    const existing = await this.db
      .prepare(
        "SELECT id FROM frozen_accounts WHERE token_id = ? AND account_address = ? AND unfrozen_at IS NULL"
      )
      .bind(input.tokenId, input.accountAddress)
      .first<{ id: string }>();

    if (existing) {
      throw new Error("ACCOUNT_ALREADY_FROZEN");
    }

    const id = `frz_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

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
  // Row Mapping Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private mapRowToToken(row: TokenRow): Token {
    let extensions: TokenExtensionsConfig | null = null;
    if (row.extensions) {
      try {
        extensions = JSON.parse(row.extensions) as TokenExtensionsConfig;
      } catch {
        extensions = null;
      }
    }

    return {
      id: row.id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      mintAddress: row.mint_address,
      mintAuthority: row.mint_authority,
      freezeAuthority: row.freeze_authority,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      description: row.description,
      uri: row.uri,
      imageUrl: row.image_url,
      extensions,
      totalSupply: row.total_supply,
      maxSupply: row.max_supply,
      isMintable: row.is_mintable === 1,
      isFreezable: row.is_freezable === 1,
      requiresAllowlist: row.requires_allowlist === 1,
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
      params = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      params = {};
    }

    return {
      id: row.id,
      tokenId: row.token_id,
      organizationId: row.organization_id,
      type: row.type as TokenTransactionType,
      status: row.status as TokenTransactionStatus,
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
      kycStatus: row.kyc_status as KycStatus,
      kycProvider: row.kyc_provider,
      kycVerifiedAt: row.kyc_verified_at,
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
