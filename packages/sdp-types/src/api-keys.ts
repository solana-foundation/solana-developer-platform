/**
 * API Key Types
 */

import type { ApiKeyRole, Permission } from "./permissions";

export type ApiKeyEnvironment = "sandbox" | "production";

export type ApiKeyStatus = "active" | "revoked" | "expired";

export type RateLimitTier = "standard" | "elevated" | "unlimited";

export interface ApiKey {
  id: string; // key_xxxxxxxxxxxx
  organizationId: string;
  createdBy: string;
  name: string;
  keyPrefix: string; // "sk_live_abc" for display
  keyHash: string; // SHA-256 of full key
  role: ApiKeyRole;
  permissions: Permission[] | null; // Override permissions, null = use role defaults
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
  createdAt: string;
}

/**
 * Cached API key data stored in KV for fast auth lookups
 */
export interface CachedApiKey {
  id: string;
  organizationId: string;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  status: ApiKeyStatus;
  expiresAt: string | null;
}

// API Request/Response types
export interface CreateApiKeyRequest {
  name: string;
  role?: ApiKeyRole;
  permissions?: Permission[];
  environment?: ApiKeyEnvironment;
  expiresAt?: string; // ISO date string
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
