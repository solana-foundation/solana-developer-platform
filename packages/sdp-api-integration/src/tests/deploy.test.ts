import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeployPrepareApiResponse, TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Token Deployment", () => {
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

  it("deploys a basic Token-2022 mint", { timeout: 60000 }, async () => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Devnet Test Token",
        symbol: "DEVTEST",
        decimals: 6,
        isMintable: true,
        isFreezable: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;
    expect(created.data.token.status).toBe("pending");

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
    expect(deployed.data.token.deployedAt).toBeTruthy();

    console.log(`Deployed mint: ${deployed.data.token.mintAddress}`);
  });

  it("deploys with transfer fee extension", { timeout: 60000 }, async () => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Transfer Fee Token",
        symbol: "TFEE",
        decimals: 6,
        extensions: {
          transferFee: {
            basisPoints: 100,
            maxFee: "1000000000",
            transferFeeConfigAuthority: custodyAddress,
            withdrawWithheldAuthority: custodyAddress,
          },
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(deployRes.status).toBe(200);
    const deployed = (await deployRes.json()) as TokenApiResponse;
    expect(deployed.data.token.mintAddress).toBeTruthy();

    console.log(`Deployed transfer fee mint: ${deployed.data.token.mintAddress}`);
  });

  it("prepares deploy transaction without executing", { timeout: 30000 }, async () => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Prepare Deploy Token",
        symbol: "PREP",
        decimals: 9,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    const prepareRes = await request(`/v1/issuance/tokens/${tokenId}/deploy/prepare`, {
      method: "POST",
    });

    expect(prepareRes.status).toBe(200);
    const prepared = (await prepareRes.json()) as DeployPrepareApiResponse;

    expect(prepared.data.transaction.serialized).toBeTruthy();
    expect(prepared.data.transaction.blockhash).toBeTruthy();
    expect(prepared.data.mint).toBeTruthy();
    expect(prepared.data.simulation).toBeDefined();

    const getRes = await request(`/v1/issuance/tokens/${tokenId}`);

    const token = (await getRes.json()) as TokenApiResponse;
    expect(token.data.token.status).toBe("pending");
  });

  it("rejects deploy for already deployed token", { timeout: 90000 }, async () => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Already Deployed",
        symbol: "DONE",
        decimals: 9,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

    await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    const secondDeployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });

    expect(secondDeployRes.status).toBe(400);
  });
});
