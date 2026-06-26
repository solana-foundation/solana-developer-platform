/**
 * Mosaic Token ACL (Freeze/Thaw) Integration Tests
 *
 * Tests freeze and thaw operations using Mosaic SDK with sRFC-37 support.
 * These tests perform real freeze/thaw operations on Solana devnet.
 *
 * sRFC-37 (Token ACL) enables:
 * - Delegated freeze authority to Token ACL program
 * - Permissionless thaw for compliant wallets
 * - Fine-grained access control per token account
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  FreezeApiResponse,
  MintApiResponse,
  TokenApiResponse,
  UnfreezeApiResponse,
} from "../helpers/api-types";
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
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
};

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mosaic Token ACL", () => {
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

  /**
   * Helper to create and deploy a token with freeze capability
   */
  async function createAndDeployFreezableToken(name: string, symbol: string) {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        symbol,
        decimals: 6,
        template: "stablecoin", // Stablecoin template supports sRFC-37
        isMintable: true,
        isFreezable: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    const deployed = (await deployRes.json()) as TokenApiResponse;
    const mintAddress = deployed.data.token.mintAddress;
    const freezeAuthority = deployed.data.token.freezeAuthority;
    if (!mintAddress) {
      throw new Error("Expected deployed token to include mintAddress");
    }
    if (!freezeAuthority) {
      throw new Error("Expected deployed token to include freezeAuthority");
    }
    return {
      tokenId,
      mintAddress,
      freezeAuthority,
    };
  }

  /**
   * Helper to mint tokens to a destination address
   */
  async function mintToDestination(tokenId: string, destination: string, amount: string) {
    const mintRes = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mint: {
          destination,
          amount,
        },
      }),
    });

    return (await mintRes.json()) as MintApiResponse;
  }

  it("freezes a token account", { timeout: 120000 }, async () => {
    // Create and deploy freezable token
    const { tokenId, mintAddress } = await createAndDeployFreezableToken(
      "Freeze Test Token",
      "FRZT"
    );
    console.log(`Deployed token: ${mintAddress}`);

    // Mint to create the token account
    const mintResult = await mintToDestination(tokenId, TEST_WALLETS.wallet1, "1");
    expect(mintResult.data.tokenAccount).toBeTruthy();
    const tokenAccount = mintResult.data.tokenAccount;
    console.log(`Minted to token account: ${tokenAccount}`);

    // Freeze the account
    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        reason: "Integration test freeze",
      }),
    });

    expect(freezeRes.status).toBe(201);
    const frozen = (await freezeRes.json()) as FreezeApiResponse;

    expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);
    expect(frozen.data.frozenAccount.reason).toBe("Integration test freeze");
    expect(frozen.data.frozenAccount.signature).toBeTruthy();

    console.log(`Freeze signature: ${frozen.data.frozenAccount.signature}`);
  });

  it("thaws a frozen token account and rejects repeat thaw", { timeout: 150000 }, async () => {
    // Create and deploy freezable token
    const { tokenId, mintAddress } = await createAndDeployFreezableToken("Thaw Test Token", "THWT");
    console.log(`Deployed token: ${mintAddress}`);

    // Mint to create the token account
    const mintResult = await mintToDestination(tokenId, TEST_WALLETS.wallet1, "1");
    const tokenAccount = mintResult.data.tokenAccount;
    console.log(`Minted to token account: ${tokenAccount}`);

    // Freeze the account first
    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        reason: "To be thawed",
      }),
    });

    expect(freezeRes.status).toBe(201);
    console.log("Account frozen, now thawing...");

    // Thaw the account
    const thawRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
      }),
    });

    expect(thawRes.status).toBe(200);
    const thawed = (await thawRes.json()) as UnfreezeApiResponse;

    expect(thawed.data.frozenAccount.accountAddress).toBe(tokenAccount);
    expect(thawed.data.frozenAccount.unfrozenAt).toBeTruthy();
    expect(thawed.data.frozenAccount.signature).toBeTruthy();

    console.log(`Thaw signature: ${thawed.data.frozenAccount.signature}`);

    const repeatThawRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
      }),
    });

    expect(repeatThawRes.status).toBe(400);
    const repeatThawError = (await repeatThawRes.json()) as {
      error: { code: string; message: string };
    };
    expect(repeatThawError.error.code).toBe("ACCOUNT_NOT_FROZEN");
  });

  it("lists frozen accounts for a token", { timeout: 120000 }, async () => {
    // Create and deploy freezable token
    const { tokenId, mintAddress } = await createAndDeployFreezableToken(
      "List Frozen Token",
      "LFT"
    );
    console.log(`Deployed token: ${mintAddress}`);

    // Mint to two different wallets
    const mint1 = await mintToDestination(tokenId, TEST_WALLETS.wallet1, "1");
    const mint2 = await mintToDestination(tokenId, TEST_WALLETS.wallet2, "1");

    // Freeze both accounts
    await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: mint1.data.tokenAccount,
        reason: "Test freeze 1",
      }),
    });

    await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: mint2.data.tokenAccount,
        reason: "Test freeze 2",
      }),
    });

    // List frozen accounts
    const listRes = await request(`/v1/issuance/tokens/${tokenId}/frozen`);

    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      data: Array<{ accountAddress: string; reason: string }>;
      meta: { total: number };
    };

    expect(list.meta.total).toBe(2);
    expect(list.data.length).toBe(2);

    const addresses = list.data.map((f) => f.accountAddress);
    expect(addresses).toContain(mint1.data.tokenAccount);
    expect(addresses).toContain(mint2.data.tokenAccount);
  });

  it("rejects freeze for non-freezable token", { timeout: 90000 }, async () => {
    // Create and deploy non-freezable token
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Non-Freezable Token",
        symbol: "NFT",
        decimals: 6,
        template: "custom",
        isMintable: true,
        isFreezable: false, // No freeze authority
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    // Deploy
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.freezeAuthority).toBeNull();

    // Mint to create the token account
    const mintResult = await mintToDestination(tokenId, TEST_WALLETS.wallet1, "1");

    // Try to freeze - should fail
    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: mintResult.data.tokenAccount,
        reason: "Should fail",
      }),
    });

    expect(freezeRes.status).toBe(400);
    const error = (await freezeRes.json()) as { error: { code: string; message: string } };
    expect(error.error.message).toContain("freeze");
  });
});
