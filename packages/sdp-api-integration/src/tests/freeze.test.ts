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

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Freeze/Unfreeze Operations", () => {
  let apiKeyHash: string;
  let custodyAddress = "";
  let custodyWalletId = "";
  let deployedTokenId = "";
  let tokenAccount = "";
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
    custodyAddress = init.custodyAddress;
    custodyWalletId = init.custodyWallet.id;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    const state = await resetIntegrationState(apiKeyHash);
    custodyAddress = state.custodyAddress;
    custodyWalletId = state.custodyWallet.id;

    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Freeze Test Token",
        symbol: "FREEZE",
        signingCustodyWalletId: custodyWalletId,
        decimals: 9,
        isMintable: true,
        isFreezable: true,
      }),
    });

    const created = (await createRes.json()) as TokenApiResponse;
    deployedTokenId = created.data.token.id;

    await request(`/v1/issuance/tokens/${deployedTokenId}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingCustodyWalletId: custodyWalletId }),
    });

    const mintRes = await request(`/v1/issuance/tokens/${deployedTokenId}/mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signingCustodyWalletId: custodyWalletId,
        mint: {
          destination: custodyAddress,
          amount: "1",
        },
      }),
    });

    const minted = (await mintRes.json()) as MintApiResponse;
    tokenAccount = minted.data.tokenAccount;
  }, 90000);

  it("freezes a token account", { timeout: 60000 }, async () => {
    const freezeRes = await request(`/v1/issuance/tokens/${deployedTokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        reason: "Integration test freeze",
        signingCustodyWalletId: custodyWalletId,
      }),
    });

    expect(freezeRes.status).toBe(201);
    const frozen = (await freezeRes.json()) as FreezeApiResponse;

    expect(frozen.data.frozenAccount.id).toMatch(/^frz_/);
    expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);
    expect(frozen.data.frozenAccount.reason).toBe("Integration test freeze");
  });

  it("unfreezes a frozen account", { timeout: 90000 }, async () => {
    await request(`/v1/issuance/tokens/${deployedTokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        signingCustodyWalletId: custodyWalletId,
      }),
    });

    const unfreezeRes = await request(`/v1/issuance/tokens/${deployedTokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        signingCustodyWalletId: custodyWalletId,
      }),
    });

    expect(unfreezeRes.status).toBe(200);
    const unfrozen = (await unfreezeRes.json()) as UnfreezeApiResponse;

    expect(unfrozen.data.frozenAccount.unfrozenAt).toBeTruthy();
  });
});
