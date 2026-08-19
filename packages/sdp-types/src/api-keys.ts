/**
 * API Key Types
 */

import type { ApiKeyRole, Permission } from "./permissions";
import type { ApiKeyWalletPolicyBindingScope } from "./policy";

export type SdpEnvironment = "sandbox" | "production";

export type ApiKeyEnvironment = SdpEnvironment;

export type ApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

export type RateLimitTier = "standard" | "elevated" | "unlimited";

export type ApiKeyWalletScope = "all" | "selected";

export interface ApiKeyWalletBinding {
  walletId: string;
  permissions: Permission[];
}

/** Internal authorization identity carried only in API-key auth/cache state. */
export interface ApiKeyWalletAuthorizationBinding extends ApiKeyWalletBinding {
  custodyWalletId?: string;
}

export interface ApiKeyWalletPolicyBindingSummary {
  id: string;
  bindingScope: ApiKeyWalletPolicyBindingScope;
  walletId: string | null;
  custodyWalletId: string | null;
  walletControlProfileId: string | null;
  walletControlProfileRevisionId: string | null;
  apiKeyControlProfileId: string | null;
  apiKeyControlProfileRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string; // key_xxxxxxxxxxxx
  organizationId: string;
  projectId: string;
  createdBy: string;
  name: string;
  description: string | null;
  keyPrefix: string; // "sk_live_abc" for display
  keyHash: string; // SHA-256 of full key
  role: ApiKeyRole;
  permissions: Permission[] | null; // Override permissions, null = use role defaults
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null; // IPv4/IPv6 addresses or CIDR ranges for IP restriction
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  rotatedFrom: string | null; // Previous key ID if this was created via rotation
  rotationDeadline: string | null; // Grace period end for the rotated-from key
  signingWalletId: string | null; // Custody wallet binding (e.g. privy_xxx)
  walletScope?: ApiKeyWalletScope;
  signingWalletIds?: string[]; // Optional multi-wallet bindings (wallet IDs)
  walletBindings?: ApiKeyWalletBinding[]; // Optional wallet-level permission bindings
  policyBindings?: ApiKeyWalletPolicyBindingSummary[];
  status: ApiKeyStatus;
  createdAt: string;
}

/**
 * Cached API key data stored in KV for fast auth lookups
 */
export interface CachedApiKey {
  id: string;
  organizationId: string;
  projectId: string;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null;
  signingWalletId: string | null;
  walletScope?: ApiKeyWalletScope;
  signingWalletIds?: string[];
  walletBindings?: ApiKeyWalletAuthorizationBinding[];
  policyBindings?: ApiKeyWalletPolicyBindingSummary[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  /**
   * Grace-period end for a rotated key. Undefined is reserved for legacy cache
   * entries written before rotation-deadline enforcement was deployed.
   */
  rotationDeadline?: string | null;
  /**
   * Status of the owning organization. Authentication rejects any key whose
   * organization is not active, independently of the key's own status — a key
   * created or rotated after an organization deletion enumerated its keys is
   * never covered by that deletion's revocation or cache refresh. Undefined is
   * reserved for legacy cache entries written before this check was deployed.
   */
  organizationStatus?: string;
  /**
   * Set on a cache entry a miss-path fill has installed but not yet verified
   * against Postgres. Readers must treat such entries as cache misses: the
   * install's snapshot predates its CAS win, and cache eviction can have
   * erased a newer revocation's terminal entry in between. The fill replaces
   * the marker with a trusted entry only after its post-install Postgres read
   * comes back clean.
   */
  pendingVerification?: true;
}

// API Request/Response types
export interface CreateApiKeyRequest {
  name: string;
  description?: string;
  role?: ApiKeyRole;
  permissions?: Permission[];
  walletScope: ApiKeyWalletScope;
  allowedIps?: string[]; // IPv4/IPv6 addresses or CIDR ranges for IP restriction
  expiresAt?: string; // ISO date string
  signingWalletId?: string;
  signingWalletIds?: string[];
  walletBindings?: Array<{
    walletId: string;
    permissions?: Permission[];
  }>;
  provisionWallet?: boolean | { connectionId: string };
  walletLabel?: string;
  walletPurpose?: string;
}

export interface UpdateApiKeyRequest {
  name?: string;
  description?: string;
  walletScope?: ApiKeyWalletScope;
  allowedIps?: string[] | null; // null to remove IP restrictions
  expiresAt?: string | null; // null to remove expiration
  permissions?: Permission[] | null; // null to revert to role defaults
  signingWalletId?: string | null; // null to unset binding
  signingWalletIds?: string[] | null;
  walletBindings?: Array<{
    walletId: string;
    permissions?: Permission[];
  }> | null;
}

export interface RotateApiKeyRequest {
  gracePeriodHours?: number; // How long old key remains valid (default: 24)
}

export interface RotateApiKeyResponse {
  apiKey: {
    id: string;
    name: string;
    key: string; // Full new key, only shown once!
    keyPrefix: string;
    role: ApiKeyRole;
    environment: ApiKeyEnvironment;
    expiresAt: string | null;
    createdAt: string;
  };
  previousKey: {
    id: string;
    rotationDeadline: string; // When old key will stop working
  };
}

export interface CreateApiKeyResponse {
  apiKey: {
    id: string;
    name: string;
    key: string; // Full key, only shown once!
    keyPrefix: string;
    role: ApiKeyRole;
    environment: ApiKeyEnvironment;
    expiresAt: string | null;
    createdAt: string;
  };
}

export interface ListApiKeysResponse {
  apiKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    role: ApiKeyRole;
    environment: ApiKeyEnvironment;
    status: ApiKeyStatus;
    walletScope: ApiKeyWalletScope;
    signingWalletId: string | null;
    signingWalletIds: string[];
    walletBindings: ApiKeyWalletBinding[];
    policyBindings: ApiKeyWalletPolicyBindingSummary[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
}

export interface RevokeApiKeyResponse {
  success: boolean;
  revokedAt: string;
}
