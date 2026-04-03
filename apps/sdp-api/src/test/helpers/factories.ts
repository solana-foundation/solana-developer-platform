/**
 * Test Factories
 *
 * Builder functions for creating test fixtures with sensible defaults.
 * Use these instead of verbose inline object creation in tests.
 */

import type { CachedApiKey, Token, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";

// ═══════════════════════════════════════════════════════════════════════════
// Counters for unique IDs
// ═══════════════════════════════════════════════════════════════════════════

let orgCounter = 0;
let userCounter = 0;
let projectCounter = 0;
let keyCounter = 0;
let tokenCounter = 0;

/**
 * Reset counters between test suites
 */
export function resetFactoryCounters(): void {
  orgCounter = 0;
  userCounter = 0;
  projectCounter = 0;
  keyCounter = 0;
  tokenCounter = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Organization
// ═══════════════════════════════════════════════════════════════════════════

export interface OrganizationOverrides {
  id?: string;
  name?: string;
  slug?: string;
  tier?: "individual" | "enterprise";
  status?: "active" | "suspended" | "deleted";
  createdAt?: string;
  updatedAt?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: "individual" | "enterprise";
  status: "active" | "suspended" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export function createOrganization(overrides: OrganizationOverrides = {}): Organization {
  const n = ++orgCounter;
  return {
    id: `org_factory_${n.toString().padStart(8, "0")}`,
    name: `Factory Org ${n}`,
    slug: `factory-org-${n}`,
    tier: "individual",
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// User
// ═══════════════════════════════════════════════════════════════════════════

export interface UserOverrides {
  id?: string;
  email?: string;
  emailVerified?: boolean;
  status?: "active" | "suspended" | "deleted";
}

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  status: "active" | "suspended" | "deleted";
}

export function createUser(overrides: UserOverrides = {}): User {
  const n = ++userCounter;
  return {
    id: `usr_factory_${n.toString().padStart(8, "0")}`,
    email: `user${n}@factory.test`,
    emailVerified: false,
    status: "active",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Project
// ═══════════════════════════════════════════════════════════════════════════

export interface ProjectOverrides {
  id?: string;
  organizationId?: string;
  name?: string;
  slug?: string;
  environment?: "sandbox" | "production";
  status?: "active" | "suspended" | "deleted";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  environment: "sandbox" | "production";
  status: "active" | "suspended" | "deleted";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function createProject(overrides: ProjectOverrides = {}): Project {
  const n = ++projectCounter;
  return {
    id: `prj_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
    name: `Factory Project ${n}`,
    slug: `factory-project-${n}`,
    environment: "sandbox",
    status: "active",
    createdBy: `usr_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API Key
// ═══════════════════════════════════════════════════════════════════════════

export interface ApiKeyOverrides {
  id?: string;
  raw?: string;
  prefix?: string;
}

export interface ApiKey {
  id: string;
  raw: string;
  prefix: string;
}

export function createApiKey(overrides: ApiKeyOverrides = {}): ApiKey {
  const n = ++keyCounter;
  const randomPart = Math.random().toString(36).substring(2, 34).padEnd(32, "x");
  return {
    id: `key_factory_${n.toString().padStart(8, "0")}`,
    raw: `sk_test_${randomPart}`,
    prefix: `sk_test_${randomPart.slice(0, 3)}`,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Cached API Key
// ═══════════════════════════════════════════════════════════════════════════

export interface CachedApiKeyOverrides {
  id?: string;
  organizationId?: string;
  projectId?: string | null;
  role?: "api_admin" | "api_developer" | "api_readonly";
  permissions?: CachedApiKey["permissions"];
  environment?: "sandbox" | "production";
  rateLimitTier?: "standard" | "elevated" | "unlimited";
  allowedIps?: string[] | null;
  signingWalletId?: string | null;
  status?: "active" | "revoked" | "expired" | "deactivated";
  expiresAt?: string | null;
}

export function createCachedApiKey(overrides: CachedApiKeyOverrides = {}): CachedApiKey {
  const n = keyCounter; // Use current counter without incrementing
  return {
    id: `key_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
    projectId: null,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenOverrides {
  id?: string;
  projectId?: string;
  organizationId?: string;
  mintAddress?: string | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  name?: string;
  symbol?: string;
  decimals?: number;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
  extensions?: Token["extensions"];
  totalSupply?: string;
  totalSupplyUpdatedAt?: string | null;
  maxSupply?: string | null;
  isMintable?: boolean;
  isFreezable?: boolean;
  requiresAllowlist?: boolean;
  template?: Token["template"];
  ablListAddress?: string | null;
  status?: Token["status"];
  deployedAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createToken(overrides: TokenOverrides = {}): Token {
  const n = ++tokenCounter;
  return {
    id: `tok_factory_${n.toString().padStart(8, "0")}`,
    projectId: `prj_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
    signingWalletId: null,
    mintAddress: null,
    mintAuthority: null,
    freezeAuthority: null,
    name: `Factory Token ${n}`,
    symbol: `FT${n}`,
    decimals: 9,
    description: "Test token created by factory",
    uri: null,
    imageUrl: null,
    extensions: null,
    totalSupply: "0",
    totalSupplyUpdatedAt: "2024-01-01T00:00:00.000Z",
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    template: "custom",
    ablListAddress: null,
    status: "pending",
    deployedAt: null,
    createdBy: `key_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Create an active token with mint address
 */
export function createActiveToken(overrides: TokenOverrides = {}): Token {
  const base = createToken(overrides);
  return {
    ...base,
    mintAddress: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    mintAuthority: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
    freezeAuthority: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
    status: "active",
    deployedAt: "2024-01-02T00:00:00.000Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Transaction
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenTransactionOverrides {
  id?: string;
  tokenId?: string;
  organizationId?: string;
  type?: TokenTransaction["type"];
  status?: TokenTransaction["status"];
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  signature?: string | null;
  serializedTx?: string | null;
  params?: Record<string, unknown>;
  slot?: number | null;
  blockTime?: string | null;
  fee?: number | null;
  error?: string | null;
  initiatedByKeyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function createTokenTransaction(
  overrides: TokenTransactionOverrides = {}
): TokenTransaction {
  const n = tokenCounter; // Use current token counter
  return {
    id: `ttx_factory_${n.toString().padStart(8, "0")}`,
    tokenId: `tok_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
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
    initiatedByKeyId: `key_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Allowlist Entry
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenAllowlistEntryOverrides {
  id?: string;
  tokenId?: string;
  address?: string;
  label?: string | null;
  status?: "active" | "revoked";
  addedBy?: string;
  createdAt?: string;
  revokedAt?: string | null;
}

export function createAllowlistEntry(
  overrides: TokenAllowlistEntryOverrides = {}
): TokenAllowlistEntry {
  const n = tokenCounter;
  return {
    id: `tal_factory_${n.toString().padStart(8, "0")}`,
    tokenId: `tok_factory_${n.toString().padStart(8, "0")}`,
    address: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    label: "Factory Wallet",
    status: "active",
    addedBy: `key_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Solana Addresses
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valid Base58 Solana addresses for testing
 */
export const SOLANA_ADDRESSES = {
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ" as const,
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv" as const,
  wallet3: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz" as const,
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const,
};
