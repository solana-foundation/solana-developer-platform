import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  FreezeApiResponse,
  TokenApiResponse,
  TransactionApiResponse,
  TransactionListApiResponse,
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
import { createAndDeployStablecoin, mintToWallet, TEST_WALLETS } from "../helpers/issuance";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Issuance Execute Endpoints", () => {
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

  it("pauses and unpauses a token", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Pause Execute Coverage", "PAUSE");

    const pauseRes = await request(`/v1/issuance/tokens/${tokenId}/pause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as TransactionApiResponse;
    expect(paused.data.transaction.type).toBe("pause");
    expect(paused.data.transaction.status).toBe("confirmed");
    expect(paused.data.transaction.signature).toBeTruthy();

    const pausedTokenRes = await request(`/v1/issuance/tokens/${tokenId}`);
    expect(pausedTokenRes.status).toBe(200);
    const pausedToken = (await pausedTokenRes.json()) as TokenApiResponse;
    expect(pausedToken.data.token.status).toBe("paused");

    const unpauseRes = await request(`/v1/issuance/tokens/${tokenId}/unpause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(unpauseRes.status).toBe(200);
    const unpaused = (await unpauseRes.json()) as TransactionApiResponse;
    expect(unpaused.data.transaction.type).toBe("unpause");
    expect(unpaused.data.transaction.status).toBe("confirmed");
    expect(unpaused.data.transaction.signature).toBeTruthy();

    const activeTokenRes = await request(`/v1/issuance/tokens/${tokenId}`);
    expect(activeTokenRes.status).toBe(200);
    const activeToken = (await activeTokenRes.json()) as TokenApiResponse;
    expect(activeToken.data.token.status).toBe("active");
  });

  it("freezes, lists, and unfreezes a token account", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Freeze Execute Coverage", "FREEZE");
    const tokenAccount = await mintToWallet(request, tokenId, TEST_WALLETS.wallet1, "1");

    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
        reason: "Coverage freeze",
      }),
    });
    expect(freezeRes.status).toBe(201);
    const frozen = (await freezeRes.json()) as FreezeApiResponse;
    expect(frozen.data.frozenAccount.accountAddress).toBe(tokenAccount);
    expect(frozen.data.frozenAccount.signature).toBeTruthy();

    const frozenListRes = await request(`/v1/issuance/tokens/${tokenId}/frozen?page=1&pageSize=10`);
    expect(frozenListRes.status).toBe(200);
    const frozenListBody = (await frozenListRes.json()) as {
      data: Array<{ accountAddress: string }>;
      meta: { total: number };
    };
    expect(frozenListBody.meta.total).toBeGreaterThanOrEqual(1);
    expect(frozenListBody.data.some((entry) => entry.accountAddress === tokenAccount)).toBe(true);

    const unfreezeRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: tokenAccount,
      }),
    });
    expect(unfreezeRes.status).toBe(200);
    const unfrozen = (await unfreezeRes.json()) as UnfreezeApiResponse;
    expect(unfrozen.data.frozenAccount.accountAddress).toBe(tokenAccount);
    expect(unfrozen.data.frozenAccount.signature).toBeTruthy();
  });

  it("executes a burn", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Burn Execute Coverage", "BURN");
    await mintToWallet(request, tokenId, custodyAddress, "1");

    const burnRes = await request(`/v1/issuance/tokens/${tokenId}/burn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        burn: {
          source: custodyAddress,
          amount: "1",
        },
      }),
    });
    expect(burnRes.status).toBe(200);
    const burned = (await burnRes.json()) as TransactionApiResponse;
    expect(burned.data.transaction.type).toBe("burn");
    expect(burned.data.transaction.status).toBe("confirmed");
    expect(burned.data.transaction.signature).toBeTruthy();
  });

  it("executes a seize and force-burn", {
    timeout: 240000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Seize Execute Coverage", "SEIZE");
    const sourceTokenAccount = await mintToWallet(request, tokenId, TEST_WALLETS.wallet1, "4");
    const destinationTokenAccount = await mintToWallet(request, tokenId, TEST_WALLETS.wallet2, "1");

    const seizeRes = await request(`/v1/issuance/tokens/${tokenId}/seize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        seize: {
          source: sourceTokenAccount,
          destination: destinationTokenAccount,
          amount: "2",
        },
      }),
    });
    expect(seizeRes.status).toBe(200);
    const seized = (await seizeRes.json()) as TransactionApiResponse;
    expect(seized.data.transaction.type).toBe("seize");
    expect(seized.data.transaction.status).toBe("confirmed");
    expect(seized.data.transaction.signature).toBeTruthy();

    const forceBurnRes = await request(`/v1/issuance/tokens/${tokenId}/force-burn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        forceBurn: {
          source: destinationTokenAccount,
          amount: "1",
        },
      }),
    });
    expect(forceBurnRes.status).toBe(200);
    const forceBurned = (await forceBurnRes.json()) as TransactionApiResponse;
    expect(forceBurned.data.transaction.type).toBe("force_burn");
    expect(forceBurned.data.transaction.status).toBe("confirmed");
    expect(forceBurned.data.transaction.signature).toBeTruthy();
  });

  it("executes an authority update", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Authority Execute Coverage", "AUTH");

    const authorityRes = await request(`/v1/issuance/tokens/${tokenId}/authority`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        authority: {
          role: "mint",
          currentAuthority: custodyAddress,
          newAuthority: TEST_WALLETS.wallet1,
        },
      }),
    });
    expect(authorityRes.status).toBe(200);
    const authorityUpdated = (await authorityRes.json()) as TransactionApiResponse;
    expect(authorityUpdated.data.transaction.type).toBe("update_authority");
    expect(authorityUpdated.data.transaction.status).toBe("confirmed");
    expect(authorityUpdated.data.transaction.signature).toBeTruthy();
  });

  it("refreshes token supply", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Supply Refresh Coverage", "SUPPLY");
    await mintToWallet(request, tokenId, TEST_WALLETS.wallet1, "4");

    const refreshSupplyRes = await request(`/v1/issuance/tokens/${tokenId}/supply/refresh`, {
      method: "POST",
    });
    expect(refreshSupplyRes.status).toBe(200);
    const refreshed = (await refreshSupplyRes.json()) as TokenApiResponse;
    expect(refreshed.data.token.totalSupply).toBe("4");
  });

  it("lists confirmed transaction history for its own token", {
    timeout: 240000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(
      request,
      "Confirmed History Coverage",
      "HISTORY"
    );
    await mintToWallet(request, tokenId, TEST_WALLETS.wallet1, "1");

    const pauseRes = await request(`/v1/issuance/tokens/${tokenId}/pause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(pauseRes.status).toBe(200);

    const unpauseRes = await request(`/v1/issuance/tokens/${tokenId}/unpause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(unpauseRes.status).toBe(200);

    const confirmedTransactionsRes = await request(
      `/v1/issuance/tokens/${tokenId}/transactions?status=confirmed&page=1&pageSize=20`
    );
    expect(confirmedTransactionsRes.status).toBe(200);
    const confirmedTransactions =
      (await confirmedTransactionsRes.json()) as TransactionListApiResponse;
    expect(confirmedTransactions.meta.total).toBeGreaterThanOrEqual(3);

    const confirmedTypes = new Set(
      confirmedTransactions.data.map((transaction) => transaction.type)
    );
    expect(confirmedTypes.has("mint")).toBe(true);
    expect(confirmedTypes.has("pause")).toBe(true);
    expect(confirmedTypes.has("unpause")).toBe(true);
    expect(
      confirmedTransactions.data.every((transaction) => transaction.status === "confirmed")
    ).toBe(true);
  });
});
