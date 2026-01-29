/**
 * Token Types for Solana Developer Platform
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TOKEN ISSUANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The issuance API supports Token-2022 tokens with the following features:
 * - Multiple token templates (stablecoin, RWA, arcade, tokenized security)
 * - Allowlist-gated transfers
 * - Freeze/unfreeze capabilities
 * - Mint authority management
 * - Two signing modes: prepare (client signs) and execute (custody signs)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Token Status Types
// ═══════════════════════════════════════════════════════════════════════════

export type TokenStatus = "pending" | "active" | "paused" | "revoked";

export type TokenTransactionType = "mint" | "burn" | "freeze" | "unfreeze";

export type TokenTransactionStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "finalized"
  | "failed";

export type KycStatus = "none" | "pending" | "approved" | "rejected";

export type AllowlistEntryStatus = "active" | "revoked";

// ═══════════════════════════════════════════════════════════════════════════
// Token Templates
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token template types aligned with Mosaic SDK templates
 */
export type TokenTemplate = "stablecoin" | "rwa" | "arcade" | "tokenized_security" | "custom";

/**
 * Extension implementation status for feature flags
 */
export type ExtensionImplementationStatus = "implemented" | "disabled" | "planned";

/**
 * Extension name for Token-2022
 */
export type TokenExtensionName =
  | "confidentialTransfer"
  | "transferFee"
  | "interestBearing"
  | "permanentDelegate"
  | "nonTransferable"
  | "defaultAccountState"
  | "metadataPointer"
  | "groupPointer";

/**
 * Extension info for template definitions
 */
export interface ExtensionInfo {
  /** Whether the extension is implemented and available */
  status: ExtensionImplementationStatus;
  /** Whether feature flag is enabled (only relevant if status is "implemented") */
  enabled: boolean;
  /** Human-readable description */
  description: string;
}

/**
 * Template extension configuration
 */
export interface TemplateExtensionConfig {
  /** Required extensions that cannot be disabled */
  required: TokenExtensionName[];
  /** Optional extensions that are included by default but can be disabled */
  defaultEnabled: TokenExtensionName[];
  /** Optional extensions not enabled by default but can be enabled */
  available: TokenExtensionName[];
  /** Extensions incompatible with this template */
  incompatible: TokenExtensionName[];
}

/**
 * Token template definition
 */
export interface TokenTemplateDefinition {
  /** Template identifier */
  id: TokenTemplate;
  /** Human-readable name */
  name: string;
  /** Description of the template use case */
  description: string;
  /** Default decimals for this template */
  decimals: number;
  /** Maximum allowed decimals */
  maxDecimals: number;
  /** Whether allowlist is required by default */
  requiresAllowlist: boolean;
  /** Whether allowlist requirement can be overridden */
  allowlistOverridable: boolean;
  /** Default extensions configuration */
  extensions: TemplateExtensionConfig;
  /** Default extension values */
  defaultExtensions: Partial<TokenExtensionsConfig>;
}

/**
 * Template info returned by API (includes extension status)
 */
export interface TokenTemplateInfo {
  /** Template identifier */
  id: TokenTemplate;
  /** Human-readable name */
  name: string;
  /** Description of the template use case */
  description: string;
  /** Default decimals */
  decimals: number;
  /** Maximum allowed decimals */
  maxDecimals: number;
  /** Whether allowlist is required by default */
  requiresAllowlist: boolean;
  /** Whether allowlist requirement can be overridden */
  allowlistOverridable: boolean;
  /** Extension configuration with status info */
  extensions: {
    required: Array<{
      name: TokenExtensionName;
      status: ExtensionImplementationStatus;
      enabled: boolean;
    }>;
    defaultEnabled: Array<{
      name: TokenExtensionName;
      status: ExtensionImplementationStatus;
      enabled: boolean;
    }>;
    available: Array<{
      name: TokenExtensionName;
      status: ExtensionImplementationStatus;
      enabled: boolean;
    }>;
  };
}

/**
 * Token-2022 extension configuration
 */
export interface TokenExtensionsConfig {
  /** Confidential transfers enabled */
  confidentialTransfer?: boolean;
  /** Transfer fees configuration */
  transferFee?: {
    basisPoints: number;
    maxFee: string;
    transferFeeConfigAuthority: string;
    withdrawWithheldAuthority: string;
  };
  /** Interest-bearing configuration */
  interestBearing?: {
    rate: number;
    rateAuthority: string;
  };
  /** Permanent delegate for the token */
  permanentDelegate?: string;
  /** Non-transferable (soulbound) */
  nonTransferable?: boolean;
  /** Default account state (initialized, frozen) */
  defaultAccountState?: "initialized" | "frozen";
  /** Metadata pointer */
  metadataPointer?: {
    authority: string;
    metadataAddress: string;
  };
  /** Group pointer for token groups */
  groupPointer?: {
    authority: string;
    groupAddress: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Entity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token entity stored in database
 */
export interface Token {
  id: string; // tok_xxxxxxxxxxxx
  projectId: string;
  organizationId: string;
  /** Solana mint address (null until deployed) */
  mintAddress: string | null;
  /** Mint authority public key */
  mintAuthority: string | null;
  /** Freeze authority public key */
  freezeAuthority: string | null;
  name: string;
  symbol: string;
  decimals: number;
  description: string | null;
  /** Token metadata URI */
  uri: string | null;
  imageUrl: string | null;
  /** Token-2022 extensions configuration */
  extensions: TokenExtensionsConfig | null;
  /** Current total supply as decimal string */
  totalSupply: string;
  /** Maximum supply limit (null = unlimited) */
  maxSupply: string | null;
  isMintable: boolean;
  isFreezable: boolean;
  /** Requires allowlist for transfers */
  requiresAllowlist: boolean;
  status: TokenStatus;
  deployedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Token transaction record (mint, burn, freeze operations)
 */
export interface TokenTransaction {
  id: string; // ttx_xxxxxxxxxxxx
  tokenId: string;
  organizationId: string;
  type: TokenTransactionType;
  status: TokenTransactionStatus;
  /** Solana transaction signature */
  signature: string | null;
  /** Base64 encoded serialized transaction */
  serializedTx: string | null;
  /** Operation parameters */
  params: Record<string, unknown>;
  slot: number | null;
  blockTime: number | null;
  fee: number | null;
  error: string | null;
  initiatedByKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Allowlist Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token allowlist entry
 */
export interface TokenAllowlistEntry {
  id: string; // tal_xxxxxxxxxxxx
  tokenId: string;
  /** Solana wallet address */
  address: string;
  /** Human-readable label */
  label: string | null;
  kycStatus: KycStatus;
  kycProvider: string | null;
  kycVerifiedAt: string | null;
  status: AllowlistEntryStatus;
  addedBy: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * Frozen account record
 */
export interface FrozenAccount {
  id: string; // frz_xxxxxxxxxxxx
  tokenId: string;
  /** Token account or owner address */
  accountAddress: string;
  reason: string | null;
  frozenAt: string;
  frozenBy: string;
  unfrozenAt: string | null;
  unfrozenBy: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Request Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extension overrides for token creation
 * Set to false to disable an optional extension, or provide config to enable
 */
export interface ExtensionOverrides {
  /** Enable/disable confidential transfers */
  confidentialTransfer?: boolean;
  /** Enable/configure transfer fees */
  transferFee?:
    | false
    | {
        basisPoints: number;
        maxFee: string;
        transferFeeConfigAuthority?: string;
        withdrawWithheldAuthority?: string;
      };
  /** Enable/configure interest-bearing */
  interestBearing?:
    | false
    | {
        rate: number;
        rateAuthority?: string;
      };
  /** Enable/disable permanent delegate (uses platform authority) */
  permanentDelegate?: boolean;
  /** Enable/disable non-transferable */
  nonTransferable?: boolean;
  /** Set default account state */
  defaultAccountState?: "initialized" | "frozen";
}

/**
 * Template overrides for customization
 */
export interface TokenTemplateOverrides {
  /** Override template extensions */
  extensions?: ExtensionOverrides;
  /** Override allowlist requirement (only if template allows) */
  requiresAllowlist?: boolean;
}

/**
 * Create token request
 * POST /v1/issuance/tokens
 *
 * Two modes:
 * 1. Template mode: Specify template with optional overrides
 * 2. Legacy mode: Specify extensions directly (treated as template: "custom")
 */
export interface CreateTokenRequest {
  name: string;
  symbol: string;
  decimals?: number;
  description?: string;
  uri?: string;
  imageUrl?: string;
  maxSupply?: string;
  /** Token template - defaults to "custom" if not specified */
  template?: TokenTemplate;
  /** Template overrides for customization */
  overrides?: TokenTemplateOverrides;
  /** @deprecated Use template + overrides instead. Legacy extensions configuration */
  extensions?: TokenExtensionsConfig;
  /** Require allowlist for transfers */
  requiresAllowlist?: boolean;
  /** Allow minting after creation */
  isMintable?: boolean;
  /** Allow freezing token accounts */
  isFreezable?: boolean;
}

/**
 * Update token request
 * PATCH /v1/issuance/tokens/:id
 */
export interface UpdateTokenRequest {
  name?: string;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
  /** Pause or resume the token */
  status?: "active" | "paused";
}

/**
 * Add to allowlist request
 * POST /v1/issuance/tokens/:id/allowlist
 */
export interface AddAllowlistEntryRequest {
  address: string;
  label?: string;
  kycStatus?: KycStatus;
  kycProvider?: string;
}

/**
 * Freeze account request
 * POST /v1/issuance/tokens/:id/freeze
 */
export interface FreezeAccountRequest {
  /** Token account address or owner wallet address */
  accountAddress: string;
  reason?: string;
}

/**
 * Unfreeze account request
 * POST /v1/issuance/tokens/:id/unfreeze
 */
export interface UnfreezeAccountRequest {
  accountAddress: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenResponse {
  token: Token;
}

export interface ListTokensResponse {
  tokens: Token[];
}

export interface TokenTransactionResponse {
  transaction: TokenTransaction;
}

export interface TokenAllowlistResponse {
  entry: TokenAllowlistEntry;
}

export interface ListAllowlistResponse {
  entries: TokenAllowlistEntry[];
}

export interface FrozenAccountResponse {
  frozenAccount: FrozenAccount;
}

export interface ListFrozenAccountsResponse {
  frozenAccounts: FrozenAccount[];
}

export interface TokenTemplateResponse {
  template: TokenTemplateInfo;
}

export interface ListTemplatesResponse {
  templates: TokenTemplateInfo[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Statistics
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenStats {
  tokenId: string;
  totalSupply: string;
  circulatingSupply: string;
  holderCount: number;
  totalMinted: string;
  totalBurned: string;
  allowlistCount: number;
  frozenAccountCount: number;
  lastActivityAt: string | null;
}
