/**
 * API Key Types
 */

import type { Action } from "./actions";

export const SDP_ENVIRONMENTS = ["sandbox", "production"] as const;

export type SdpEnvironment = (typeof SDP_ENVIRONMENTS)[number];

export type ApiKeyEnvironment = SdpEnvironment;

export type ApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

/** A row of a key's signing-wallet list: listed, or taken off it (soft deleted). */
export const API_KEY_SIGNING_WALLET_STATUSES = ["active", "archived"] as const;
export type ApiKeySigningWalletStatus = (typeof API_KEY_SIGNING_WALLET_STATUSES)[number];

export type RateLimitTier = "standard" | "elevated" | "unlimited";

export const API_KEY_WALLET_SCOPES = ["all", "selected"] as const;

/**
 * Which custody wallets an API key may sign with (HOO-2099): every wallet in
 * its project, or only the ones it lists. A selected key that lists none
 * signs with no custody wallet (the fee sponsor is outside wallet scope).
 */
export type ApiKeyWalletScope = (typeof API_KEY_WALLET_SCOPES)[number];

export interface ApiKey {
  id: string; // key_xxxxxxxxxxxx
  organizationId: string;
  projectId: string;
  createdBy: string;
  name: string;
  description: string | null;
  keyPrefix: string; // "sk_live_abc" for display
  keyHash: string; // SHA-256 of full key
  grants: Action[]; // Explicit grants; no role, no wildcard
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null; // IPv4/IPv6 addresses or CIDR ranges for IP restriction
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  rotatedFrom: string | null; // Previous key ID if this was created via rotation
  rotationDeadline: string | null; // Grace period end for the rotated-from key
  walletScope: ApiKeyWalletScope;
  walletIds: string[]; // Custody wallet ids (`GET /v1/wallets` `id`) a selected key may sign with
  status: ApiKeyStatus;
  createdAt: string;
}

// API Request/Response types
export interface CreateApiKeyRequest {
  name: string;
  description?: string;
  grants: Action[];
  walletScope: ApiKeyWalletScope;
  walletIds?: string[]; // Custody wallet ids, for walletScope "selected"
  allowedIps?: string[]; // IPv4/IPv6 addresses or CIDR ranges for IP restriction
  expiresAt?: string; // ISO date string
}

export interface UpdateApiKeyRequest {
  name?: string;
  description?: string;
  walletScope?: ApiKeyWalletScope; // With walletIds, replaces the key's wallet scope
  walletIds?: string[];
  grants?: Action[]; // Replaces the key's grants
  allowedIps?: string[] | null; // null to remove IP restrictions
  expiresAt?: string | null; // null to remove expiration
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
    grants: Action[];
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
    grants: Action[];
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
    grants: Action[];
    environment: ApiKeyEnvironment;
    status: ApiKeyStatus;
    walletScope: ApiKeyWalletScope;
    walletIds: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    /** When a rotated key stops working; null unless it is in its grace period. */
    rotationDeadline: string | null;
    createdAt: string;
  }>;
}

export interface RevokeApiKeyRequest {
  confirmation?: string; // The key's name
  /** Also cancel the active recurring payments this key activated (the compromised-key path). */
  cancelRecurringPayments?: boolean;
}

export interface RevokeApiKeyResponse {
  success: boolean;
  revokedAt: string;
  /** Null unless the revoke asked to cancel the key's recurring payments. */
  recurringPayments: { canceled: string[]; failed: string[] } | null;
}
