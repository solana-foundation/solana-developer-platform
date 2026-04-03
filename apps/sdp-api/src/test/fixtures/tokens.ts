/**
 * Token test fixtures
 */

import type { CachedApiKey, Token, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";
import { TEST_ORG, TEST_USER } from "./organizations";

export const TEST_PROJECT = {
  id: "prj_test123456789",
  organizationId: TEST_ORG.id,
  name: "Test Project",
  slug: "test-project",
  environment: "sandbox" as const,
  status: "active" as const,
  createdBy: TEST_USER.id,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

export const TEST_PROJECT_API_KEY = {
  id: "key_proj123456789",
  raw: "sk_test_projkey12345678901234567890123",
  prefix: "sk_test_pro",
};

export const TEST_PROJECT_CACHED_KEY: CachedApiKey = {
  id: TEST_PROJECT_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

export const TEST_TOKEN: Token = {
  id: "tok_test123456789",
  projectId: TEST_PROJECT.id,
  organizationId: TEST_ORG.id,
  signingWalletId: null,
  mintAddress: null,
  mintAuthority: null,
  freezeAuthority: null,
  name: "Test Token",
  symbol: "TEST",
  decimals: 9,
  description: "A test token",
  uri: null,
  imageUrl: null,
  extensions: null,
  totalSupply: "0",
  totalSupplyUpdatedAt: "2024-01-01T00:00:00.000Z",
  maxSupply: "1000000000000000000",
  isMintable: true,
  isFreezable: true,
  requiresAllowlist: false,
  status: "pending",
  deployedAt: null,
  createdBy: TEST_PROJECT_API_KEY.id,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  // Mosaic integration fields
  ablListAddress: null,
  template: "custom",
};

export const TEST_ACTIVE_TOKEN: Token = {
  ...TEST_TOKEN,
  id: "tok_active12345678",
  mintAddress: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
  mintAuthority: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
  freezeAuthority: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
  status: "active",
  deployedAt: "2024-01-02T00:00:00.000Z",
};

export const TEST_ALLOWLIST_TOKEN: Token = {
  ...TEST_ACTIVE_TOKEN,
  id: "tok_allowlist12345",
  name: "Allowlist Token",
  symbol: "ALT",
  requiresAllowlist: true,
};

export const TEST_TOKEN_TRANSACTION: TokenTransaction = {
  id: "ttx_test123456789",
  tokenId: TEST_ACTIVE_TOKEN.id,
  organizationId: TEST_ORG.id,
  type: "mint",
  status: "pending",
  idempotencyKey: null,
  idempotencyFingerprint: null,
  signature: null,
  serializedTx: null,
  params: {
    destination: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    amount: "1",
  },
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  initiatedByKeyId: TEST_PROJECT_API_KEY.id,
  createdAt: "2024-01-03T00:00:00.000Z",
  updatedAt: "2024-01-03T00:00:00.000Z",
};

export const TEST_ALLOWLIST_ENTRY: TokenAllowlistEntry = {
  id: "tal_test123456789",
  tokenId: TEST_ALLOWLIST_TOKEN.id,
  address: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  label: "Test Wallet",
  status: "active",
  addedBy: TEST_PROJECT_API_KEY.id,
  createdAt: "2024-01-01T00:00:00.000Z",
  revokedAt: null,
};

// Solana test addresses (valid Base58)
export const TEST_SOLANA_ADDRESSES = {
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
  wallet3: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
