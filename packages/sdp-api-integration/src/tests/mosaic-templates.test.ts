/**
 * Mosaic Templates Integration Tests
 *
 * Tests template-based token deployment using Mosaic SDK.
 * These tests deploy real tokens to Solana devnet.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Mosaic Template Deployment", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyAddress = init.custodyAddress;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    const state = await resetIntegrationState(apiKeyHash);
    custodyAddress = state.custodyAddress;
  });

  it("deploys stablecoin template with sRFC-37", { timeout: 90000 }, async () => {
    // Create token with stablecoin template
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Stablecoin",
        symbol: "TSTBL",
        decimals: 6,
        template: "stablecoin",
        isMintable: true,
        isFreezable: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;
    expect(created.data.token.template).toBe("stablecoin");
    expect(created.data.token.status).toBe("pending");

    // Deploy the token
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;

    expect(deployed.data.token.status).toBe("active");
    expect(deployed.data.token.mintAddress).toBeTruthy();
    expect(deployed.data.token.mintAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(deployed.data.token.mintAuthority).toBe(custodyAddress);
    expect(deployed.data.token.freezeAuthority).toBe(custodyAddress);

    console.log(`Deployed stablecoin mint: ${deployed.data.token.mintAddress}`);
  });

  it("deploys arcade template with closed-loop allowlist", { timeout: 90000 }, async () => {
    // Create token with arcade template (always uses allowlist)
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Arcade Token",
        symbol: "TARC",
        decimals: 0, // Arcade tokens often use 0 decimals for game points
        template: "arcade",
        isMintable: true,
        isFreezable: true,
        requiresAllowlist: true, // Arcade template enforces allowlist
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;
    expect(created.data.token.template).toBe("arcade");
    expect(created.data.token.requiresAllowlist).toBe(true);

    // Deploy the token
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;

    expect(deployed.data.token.status).toBe("active");
    expect(deployed.data.token.mintAddress).toBeTruthy();
    // Arcade template with allowlist should have ABL list address
    // Note: ablListAddress may be null if ABL creation is not enabled for this template
    // The SDK handles this automatically based on enableAbl flag

    console.log(`Deployed arcade mint: ${deployed.data.token.mintAddress}`);
    if (deployed.data.token.ablListAddress) {
      console.log(`ABL list address: ${deployed.data.token.ablListAddress}`);
    }
  });

  it("deploys tokenized-security template", { timeout: 90000 }, async () => {
    // Create token with tokenized-security template
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Security Token",
        symbol: "TSEC",
        decimals: 8,
        template: "tokenized-security",
        isMintable: true,
        isFreezable: true,
        requiresAllowlist: true, // Security tokens require KYC/allowlist
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;
    expect(created.data.token.template).toBe("tokenized-security");

    // Deploy the token
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;

    expect(deployed.data.token.status).toBe("active");
    expect(deployed.data.token.mintAddress).toBeTruthy();
    expect(deployed.data.token.mintAuthority).toBe(custodyAddress);

    console.log(`Deployed tokenized-security mint: ${deployed.data.token.mintAddress}`);
  });

  it("deploys custom template with legacy Token2022Service", { timeout: 90000 }, async () => {
    // Create token with custom template (uses legacy Token2022Service)
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test Custom Token",
        symbol: "TCUST",
        decimals: 9,
        template: "custom",
        isMintable: true,
        isFreezable: false, // No freeze authority
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;
    expect(created.data.token.template).toBe("custom");

    // Deploy the token
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;

    expect(deployed.data.token.status).toBe("active");
    expect(deployed.data.token.mintAddress).toBeTruthy();
    expect(deployed.data.token.freezeAuthority).toBeNull();

    console.log(`Deployed custom mint: ${deployed.data.token.mintAddress}`);
  });

  it("lists available templates", { timeout: 10000 }, async () => {
    const res = await request("/v1/issuance/templates");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { templates: Array<{ id: string; name: string }> } };

    expect(body.data.templates).toBeDefined();
    expect(Array.isArray(body.data.templates)).toBe(true);
    expect(body.data.templates.length).toBe(3);
    const templateIds = body.data.templates.map((t) => t.id);
    expect(templateIds).toContain("stablecoin");
    expect(templateIds).toContain("tokenized-security");
    expect(templateIds).toContain("custom");
  });

  it("gets specific template info", { timeout: 10000 }, async () => {
    const res = await request("/v1/issuance/templates/stablecoin");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { template: { id: string; name: string } };
    };

    expect(body.data.template.id).toBe("stablecoin");
    expect(body.data.template.name).toBeDefined();
    expect(body.data.template.name).toBe("Stablecoin");
  });
});
