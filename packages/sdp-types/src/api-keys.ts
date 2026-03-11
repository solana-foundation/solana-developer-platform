/**
 * API Key Types
 */

import type { ApiKeyRole, Permission } from "./permissions";

export type ApiKeyEnvironment = "sandbox" | "production";

export type ApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

export type RateLimitTier = "standard" | "elevated" | "unlimited";

export type ApiKeyWalletScope = "all" | "selected";

export interface ApiKeyWalletBinding {
  walletId: string;
  permissions: Permission[];
}

export interface ApiKey {
  id: string; // key_xxxxxxxxxxxx
  organizationId: string;
  projectId: string | null; // Optional project scoping
  createdBy: string;
  name: string;
  description: string | null;
  keyPrefix: string; // "sk_live_abc" for display
  keyHash: string; // SHA-256 of full key
  role: ApiKeyRole;
  permissions: Permission[] | null; // Override permissions, null = use role defaults
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null; // CIDR ranges for IP restriction
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  rotatedFrom: string | null; // Previous key ID if this was created via rotation
  rotationDeadline: string | null; // Grace period end for the rotated-from key
  signingWalletId: string | null; // Custody wallet binding (e.g. privy_xxx)
  signingWalletIds?: string[]; // Optional multi-wallet bindings (wallet IDs)
  walletBindings?: ApiKeyWalletBinding[]; // Optional wallet-level permission bindings
  status: ApiKeyStatus;
  createdAt: string;
}

/**
 * Cached API key data stored in KV for fast auth lookups
 */
export interface CachedApiKey {
  id: string;
  organizationId: string;
  projectId: string | null;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null;
  signingWalletId: string | null;
  signingWalletIds?: string[];
  walletBindings?: ApiKeyWalletBinding[];
  status: ApiKeyStatus;
  expiresAt: string | null;
}

// API Request/Response types
export interface CreateApiKeyRequest {
  name: string;
  description?: string;
  role?: ApiKeyRole;
  permissions?: Permission[];
  environment?: ApiKeyEnvironment;
  walletScope: ApiKeyWalletScope;
  allowedIps?: string[]; // CIDR ranges for IP restriction
  expiresAt?: string; // ISO date string
  signingWalletId?: string;
  signingWalletIds?: string[];
  walletBindings?: Array<{
    walletId: string;
    permissions?: Permission[];
  }>;
  provisionWallet?: boolean;
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
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
}

export interface RevokeApiKeyResponse {
  success: boolean;
  revokedAt: string;
}
