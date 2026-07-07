/**
 * Mosaic Service Types
 *
 * Type definitions for Mosaic SDK integration.
 * These map SDP's domain types to Mosaic SDK concepts.
 */

import type { TokenExtensionsConfig, TokenTemplate } from "@sdp/types";
import type { Address, TransactionSigner } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Template Mapping
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mosaic template types that map to SDP templates
 */
export type MosaicTemplate = "stablecoin" | "arcade" | "tokenized-security" | "custom";

/**
 * Maps SDP template IDs to Mosaic template types
 */
export const TEMPLATE_MAP: Record<string, MosaicTemplate> = {
  stablecoin: "stablecoin",
  rwa: "tokenized-security", // RWA uses tokenized-security template
  arcade: "arcade",
  "tokenized-security": "tokenized-security",
  tokenized_security: "tokenized-security",
  custom: "custom",
};

/**
 * ACL mode for on-chain access control
 */
export type AclMode = "allowlist" | "blocklist";

/**
 * Default ACL modes per template
 */
export const DEFAULT_ACL_MODE: Record<MosaicTemplate, AclMode> = {
  stablecoin: "blocklist", // Open by default, can block bad actors
  arcade: "allowlist", // Closed by default for gaming
  "tokenized-security": "allowlist", // Regulatory requirement
  custom: "allowlist",
};

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result from Mosaic transaction builders
 */
export interface MosaicTransaction {
  /** Serialized transaction (base64) */
  serializedTx: string;
  /** Blockhash used */
  blockhash: string;
  /** Last valid block height */
  lastValidBlockHeight: bigint;
  /** Mint address (for deploy operations) */
  mint?: Address;
  /** ABL list address (for templates with ACL) */
  listAddress?: Address;
  /** Required signers */
  requiredSigners: Address[];
}

/**
 * Result from executed transactions
 */
export interface MosaicTransactionResult {
  signature: string;
  slot: bigint;
  mint?: Address;
  tokenAccount?: Address;
  listAddress?: Address;
}

/**
 * Thrown by createToken's overflow path when the mint was created on-chain (the
 * slim create tx confirmed) but the follow-up metadata-URI update failed.
 *
 * Carries the live mint (and its list address) so the caller can persist it
 * before surfacing the error — otherwise a retry generates a fresh mint keypair
 * and creates a second on-chain mint, permanently orphaning the first.
 */
export class MintMetadataUpdateError extends Error {
  constructor(
    readonly result: MosaicTransactionResult,
    options?: { cause?: unknown }
  ) {
    super("Token mint created on-chain, but setting the metadata URI failed", options);
    this.name = "MintMetadataUpdateError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Creation Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token metadata for Mosaic
 */
export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Options for creating a token with Mosaic
 */
export interface CreateTokenOptions {
  /** SDP template ID */
  template: TokenTemplate;
  /** Token metadata */
  metadata: TokenMetadata;
  /** Token decimals */
  decimals: number;
  /** Mint authority address */
  mintAuthority: Address | TransactionSigner;
  /** Freeze authority (null to disable) */
  freezeAuthority: Address | null;
  /** Fee payer for the deploy transaction */
  feePayer: TransactionSigner;
  /** Extension configuration from SDP */
  extensions?: TokenExtensionsConfig;
  /** Enable on-chain ABL */
  enableAbl?: boolean;
  /** ACL mode override */
  aclMode?: AclMode;
  /** Enable sRFC-37 Token ACL */
  enableTokenAcl?: boolean;
}

/**
 * Options for minting tokens
 * Note: amount is a number (decimal amount), not bigint.
 * The Mosaic SDK handles conversion to raw amount using mint decimals.
 */
export interface MintToOptions {
  mint: Address;
  destination: Address;
  /** Decimal amount (e.g., 100 for 100 tokens) - SDK handles conversion */
  amount: number;
  mintAuthority: Address;
  feePayer: Address;
}

/**
 * Options for transfering tokens between wallets.
 * Amount is a decimal string; Mosaic resolves mint decimals from chain state.
 */
export interface TransferOptions {
  mint: Address;
  from: Address;
  to: Address;
  amount: string;
  memo?: string;
  authority: Address;
  feePayer: Address;
}

/**
 * Execution options for transfering tokens with custody signing.
 */
export interface ExecuteTransferOptions {
  mint: Address;
  from: Address;
  to: Address;
  amount: string;
  memo?: string;
  authority: TransactionSigner;
  feePayer: TransactionSigner;
}

/**
 * Options for burning tokens
 */
export interface BurnOptions {
  mint: Address;
  source: Address;
  amount: bigint;
  authority: Address;
  feePayer: Address;
}

/**
 * Options for freeze/thaw operations.
 * Note: mint is NOT required - the SDK fetches it from the token account.
 */
export interface FreezeThawOptions {
  /** Token account to freeze/thaw */
  tokenAccount: Address;
  /** Fee payer (used if Kora not configured) */
  feePayer: Address;
}

/**
 * Options for force transfer (permanent delegate)
 */
export interface ForceTransferOptions {
  mint: Address;
  source: Address;
  destination: Address;
  amount: bigint;
  permanentDelegate: Address;
  feePayer: Address;
}

/**
 * Options for updating on-chain token metadata fields.
 */
export interface UpdateMetadataOptions {
  mint: Address;
  name?: string;
  uri?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  updateAuthority: TransactionSigner;
  feePayer: TransactionSigner;
}

// ═══════════════════════════════════════════════════════════════════════════
// ABL (Allowlist/Blocklist) Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for ABL list operations.
 *
 * Note: the on-chain authority and fee payer are not part of this shape — the
 * service derives both from its configured signer (`this.signer` /
 * `resolveFeePayerSigner()`), so callers cannot override them.
 */
export interface AblListOptions {
  /** List address */
  list: Address;
}

/**
 * Options for adding/removing wallets from ABL
 */
export interface AblWalletOptions extends AblListOptions {
  /** Wallet to add/remove */
  wallet: Address;
}

/**
 * ABL list info
 */
export interface AblListInfo {
  address: Address;
  authority: Address;
  listType: AclMode;
  walletCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for MosaicService
 */
export interface MosaicServiceConfig {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Enable transaction simulation by default */
  defaultSimulate?: boolean;
  /** Commitment level */
  commitment?: "processed" | "confirmed" | "finalized";
}
