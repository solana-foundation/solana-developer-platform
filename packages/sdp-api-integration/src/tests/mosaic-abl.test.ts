/**
 * Mosaic ABL (Allowlist/Blocklist) Integration Tests
 *
 * Tests on-chain ABL operations using Mosaic SDK.
 * These tests manage real allowlist entries on Solana devnet.
 *
 * Note: ABL operations require a token deployed with enableAbl=true.
 * The allowlist API (/v1/issuance/tokens/:tokenId/allowlist) manages
 * database records, while the on-chain ABL is managed via Mosaic SDK.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenAllowlistResponse, TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

// Test wallet addresses (valid Base58)
const TEST_WALLETS = {
  // biome-ignore lint/security/noSecrets: Test Solana address
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  // biome-ignore lint/security/noSecrets: Test Solana address
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
  // biome-ignore lint/security/noSecrets: Test Solana address
  wallet3: "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
};

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mosaic ABL Operations", () => {
  let apiKeyHash: string;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  it("adds wallet to allowlist database", { timeout: 30000 }, async () => {
    // Create and deploy a token with allowlist requirement
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ABL Test Token",
        symbol: "ABLT",
        decimals: 6,
        template: "stablecoin",
        isMintable: true,
        isFreezable: true,
        requiresAllowlist: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Add wallet to allowlist (database level)
    const addRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "Test Wallet 1",
      }),
    });

    expect(addRes.status).toBe(201);
    const entry = (await addRes.json()) as TokenAllowlistResponse;
    expect(entry.data.entry.address).toBe(TEST_WALLETS.wallet1);
    expect(entry.data.entry.label).toBe("Test Wallet 1");
    expect(entry.data.entry.status).toBe("active");
  });

  it("lists allowlist entries", { timeout: 30000 }, async () => {
    // Create token
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "List Test Token",
        symbol: "LSTT",
        decimals: 6,
        template: "stablecoin",
        requiresAllowlist: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Add multiple wallets
    for (const [key, address] of Object.entries(TEST_WALLETS)) {
      await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          address,
          label: `Test ${key}`,
        }),
      });
    }

    // List allowlist entries
    const listRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`);

    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      data: Array<{ address: string; status: string }>;
      meta: { total: number };
    };

    expect(list.data.length).toBe(3);
    expect(list.meta.total).toBe(3);

    const addresses = list.data.map((e) => e.address);
    expect(addresses).toContain(TEST_WALLETS.wallet1);
    expect(addresses).toContain(TEST_WALLETS.wallet2);
    expect(addresses).toContain(TEST_WALLETS.wallet3);
  });

  it("removes wallet from allowlist", { timeout: 30000 }, async () => {
    // Create token
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Remove Test Token",
        symbol: "RMVT",
        decimals: 6,
        template: "stablecoin",
        requiresAllowlist: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Add wallet
    const addRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "To Be Removed",
      }),
    });

    const entry = (await addRes.json()) as TokenAllowlistResponse;
    const entryId = entry.data.entry.id;

    // Remove wallet
    const removeRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist/${entryId}`, {
      method: "DELETE",
    });

    expect(removeRes.status).toBe(204);

    // Verify removal
    const listRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`);

    const list = (await listRes.json()) as {
      data: Array<{ address: string; status: string }>;
    };

    // Entry should be revoked, not deleted
    const revokedEntry = list.data.find((e) => e.address === TEST_WALLETS.wallet1);
    // Depending on implementation, either filtered out or marked as revoked
    if (revokedEntry) {
      expect(revokedEntry.status).toBe("revoked");
    }
  });

  it("rejects duplicate allowlist entries", { timeout: 30000 }, async () => {
    // Create token
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Dupe Test Token",
        symbol: "DUPT",
        decimals: 6,
        template: "stablecoin",
        requiresAllowlist: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Add wallet first time
    await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "First Add",
      }),
    });

    // Try to add same wallet again
    const dupeRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "Duplicate Add",
      }),
    });

    expect(dupeRes.status).toBe(409); // Conflict
  });

  it("rejects invalid wallet address", { timeout: 10000 }, async () => {
    // Create token
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Invalid Addr Token",
        symbol: "INVT",
        decimals: 6,
        template: "stablecoin",
        requiresAllowlist: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Try to add invalid address
    const invalidRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: "not-a-valid-solana-address",
        label: "Invalid",
      }),
    });

    expect(invalidRes.status).toBe(400);
  });
});
