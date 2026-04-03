/**
 * Custody test fixtures
 */

import type { SigningConfigRecord } from "@/services/adapters/signing";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { TEST_ORG } from "./organizations";
import { TEST_PROJECT } from "./tokens";

// Test Solana addresses (valid Base58)
export const TEST_CUSTODY_PUBLIC_KEY = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";

/**
 * Test custody config for the test organization (org-level).
 * Uses "local" provider with a placeholder encrypted key.
 */
export const TEST_CUSTODY_CONFIG: SigningConfigRecord = {
  id: "cust_test123456789",
  organizationId: TEST_ORG.id,
  projectId: null,
  provider: "local",
  // This is a placeholder - in tests, we'd use a mock encryption key
  config: JSON.stringify({
    provider: "local",
    encryptedPrivateKey: "test_encrypted_key_placeholder",
  }),
  defaultWalletId: TEST_CUSTODY_PUBLIC_KEY,
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/**
 * Test custody config for a specific project.
 */
export const TEST_PROJECT_CUSTODY_CONFIG: SigningConfigRecord = {
  id: "cust_proj123456789",
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  provider: "local",
  config: JSON.stringify({
    provider: "local",
    encryptedPrivateKey: "test_project_encrypted_key_placeholder",
  }),
  defaultWalletId: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  status: "active",
  createdAt: "2024-01-02T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
};

/**
 * Test custody wallet (root wallet for org config).
 */
export const TEST_CUSTODY_WALLET: CustodyWallet = {
  id: "cwlt_test123456789",
  custodyConfigId: TEST_CUSTODY_CONFIG.id,
  walletId: TEST_CUSTODY_PUBLIC_KEY,
  publicKey: TEST_CUSTODY_PUBLIC_KEY,
  label: "Root Signing Wallet",
  purpose: "root",
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
};

/**
 * Test custody wallet for project-specific config.
 */
export const TEST_PROJECT_CUSTODY_WALLET: CustodyWallet = {
  id: "cwlt_proj123456789",
  custodyConfigId: TEST_PROJECT_CUSTODY_CONFIG.id,
  walletId: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  publicKey: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  label: "Project Signing Wallet",
  purpose: "root",
  status: "active",
  createdAt: "2024-01-02T00:00:00.000Z",
};

/**
 * Test Fireblocks custody config (inactive - for testing provider switching).
 */
export const TEST_FIREBLOCKS_CUSTODY_CONFIG: SigningConfigRecord = {
  id: "cust_fb_123456789",
  organizationId: TEST_ORG.id,
  projectId: null,
  provider: "fireblocks",
  config: JSON.stringify({
    provider: "fireblocks",
    apiKey: "test-fb-api-key",
    apiSecretEncrypted: "test_encrypted_fb_secret",
    vaultAccountId: "vault-123",
    assetId: "SOL",
  }),
  defaultWalletId: "fb_vault-123",
  status: "inactive",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};
