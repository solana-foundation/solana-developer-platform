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
 * Test custody config for the test project.
 * Uses "local" provider with a placeholder encrypted key.
 */
export const TEST_CUSTODY_CONFIG: SigningConfigRecord = {
  id: "cust_test123456789",
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  provider: "local",
  // This is a placeholder - in tests, we'd use a mock encryption key
  config: JSON.stringify({
    provider: "local",
    encryptedPrivateKey: "test_encrypted_key_placeholder",
  }),
  encryptionVersion: "sdp-custody-encryption-v1",
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/**
 * Test custody wallet (root wallet for the test project config).
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
