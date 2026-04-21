import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MintApiResponse, TokenApiResponse, TransactionRecord } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

type PreparedTransactionResponse = {
  data: {
    transaction: TransactionRecord;
    preparedTransaction: {
      serialized: string;
      blockhash: string;
      lastValidBlockHeight?: string;
    };
    simulation?: unknown;
  };
};

type ExecuteTransactionResponse = {
  data: {
    transaction: TransactionRecord;
  };
};

type TransactionListResponse = {
  data: TransactionRecord[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
};

const TEST_WALLETS = {
  // biome-ignore lint/security/noSecrets: Test Solana address.
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  // biome-ignore lint/security/noSecrets: Test Solana address.
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
};

const stablecoinPayload = (name: string, symbol: string) => ({
  name,
  symbol,
  template: "stablecoin",
  decimals: 6,
  isMintable: true,
  isFreezable: true,
});

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Issuance Endpoint Coverage", () => {
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

  const createStablecoin = async (name: string, symbol: string) => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stablecoinPayload(name, symbol)),
    });
    expect(createRes.status).toBe(201);

    const created = (await createRes.json()) as TokenApiResponse;
    return created.data.token.id;
  };

  const createAndDeployStablecoin = async (name: string, symbol: string) => {
    const tokenId = await createStablecoin(name, symbol);
    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });
    expect(deployRes.status).toBe(200);

    return tokenId;
  };

  const mintToWallet = async (tokenId: string, destination: string, amount: string) => {
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

    expect(mintRes.status).toBe(200);
    const mintBody = (await mintRes.json()) as MintApiResponse;
    expect(mintBody.data.transaction.status).toBe("confirmed");
    expect(mintBody.data.tokenAccount).toBeTruthy();
    return mintBody.data.tokenAccount;
  };

  it("covers templates, token CRUD, and allowlist endpoints", async () => {
    const templatesRes = await request("/v1/issuance/templates");
    expect(templatesRes.status).toBe(200);
    const templatesBody = (await templatesRes.json()) as {
      data: { templates: Array<{ id: string }> };
    };
    expect(templatesBody.data.templates.length).toBeGreaterThan(0);
    expect(templatesBody.data.templates.some((t) => t.id === "stablecoin")).toBe(true);

    const templateRes = await request("/v1/issuance/templates/stablecoin");
    expect(templateRes.status).toBe(200);
    const templateBody = (await templateRes.json()) as {
      data: { template: { id: string } };
    };
    expect(templateBody.data.template.id).toBe("stablecoin");

    const tokenId = await createStablecoin("Issuance CRUD Coverage", "ISCRUD");

    // biome-ignore lint/security/noSecrets: Query params used for pagination, not a secret.
    const listTokensRes = await request("/v1/issuance/tokens?page=1&pageSize=20");
    expect(listTokensRes.status).toBe(200);
    const listTokensBody = (await listTokensRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(listTokensBody.meta.total).toBeGreaterThanOrEqual(1);
    expect(listTokensBody.data.some((t) => t.id === tokenId)).toBe(true);

    const getTokenRes = await request(`/v1/issuance/tokens/${tokenId}`);
    expect(getTokenRes.status).toBe(200);
    const getTokenBody = (await getTokenRes.json()) as TokenApiResponse;
    expect(getTokenBody.data.token.id).toBe(tokenId);

    const patchTokenRes = await request(`/v1/issuance/tokens/${tokenId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "Updated by integration test",
      }),
    });
    expect(patchTokenRes.status).toBe(200);
    const patchedTokenBody = (await patchTokenRes.json()) as TokenApiResponse;
    expect(patchedTokenBody.data.token.description).toBe("Updated by integration test");

    const emptyAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(emptyAllowlistRes.status).toBe(200);
    const emptyAllowlistBody = (await emptyAllowlistRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(emptyAllowlistBody.meta.total).toBe(0);

    const addAllowlistRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "Integration Wallet 1",
      }),
    });
    expect(addAllowlistRes.status).toBe(201);
    const addAllowlistBody = (await addAllowlistRes.json()) as {
      data: { entry: { id: string; address: string } };
    };
    expect(addAllowlistBody.data.entry.address).toBe(TEST_WALLETS.wallet1);

    const listAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(listAllowlistRes.status).toBe(200);
    const listAllowlistBody = (await listAllowlistRes.json()) as {
      data: Array<{ id: string; address: string }>;
      meta: { total: number };
    };
    expect(listAllowlistBody.meta.total).toBe(1);
    expect(listAllowlistBody.data[0]?.address).toBe(TEST_WALLETS.wallet1);

    const removeAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist/${addAllowlistBody.data.entry.id}`,
      {
        method: "DELETE",
      }
    );
    expect(removeAllowlistRes.status).toBe(204);

    const afterDeleteAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(afterDeleteAllowlistRes.status).toBe(200);
    const afterDeleteAllowlistBody = (await afterDeleteAllowlistRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(afterDeleteAllowlistBody.meta.total).toBe(0);
  });

  it("covers deploy/mint/burn/seize/force-burn/authority prepare endpoints and pending history", {
    timeout: 240000,
  }, async () => {
    const tokenId = await createStablecoin("Issuance Prepare Coverage", "ISPREP");

    const deployPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/deploy/prepare`, {
      method: "POST",
    });
    expect(deployPrepareRes.status).toBe(200);
    const deployPrepared = (await deployPrepareRes.json()) as {
      data: {
        transaction: { serialized: string; blockhash: string };
        mint: string;
      };
    };
    expect(deployPrepared.data.transaction.serialized).toBeTruthy();
    expect(deployPrepared.data.transaction.blockhash).toBeTruthy();
    expect(deployPrepared.data.mint).toBeTruthy();

    const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
      method: "POST",
    });
    expect(deployRes.status).toBe(200);
    const deployedToken = (await deployRes.json()) as TokenApiResponse;
    expect(deployedToken.data.token.status).toBe("active");

    const mintPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/mint/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mint: {
          destination: TEST_WALLETS.wallet1,
          amount: "1",
        },
        options: {
          simulate: true,
        },
      }),
    });
    expect(mintPrepareRes.status).toBe(200);
    const mintPrepared = (await mintPrepareRes.json()) as PreparedTransactionResponse;
    expect(mintPrepared.data.transaction.type).toBe("mint");
    expect(mintPrepared.data.preparedTransaction.serialized).toBeTruthy();

    const sourceTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet1, "3");
    const destinationTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet2, "1");
    await mintToWallet(tokenId, custodyAddress, "1");

    const burnPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/burn/prepare`, {
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
    expect(burnPrepareRes.status).toBe(200);
    const burnPrepared = (await burnPrepareRes.json()) as PreparedTransactionResponse;
    expect(burnPrepared.data.transaction.type).toBe("burn");
    expect(burnPrepared.data.preparedTransaction.serialized).toBeTruthy();

    const seizePrepareRes = await request(`/v1/issuance/tokens/${tokenId}/seize/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        seize: {
          source: sourceTokenAccount,
          destination: destinationTokenAccount,
          amount: "1",
        },
      }),
    });
    expect(seizePrepareRes.status).toBe(200);
    const seizePrepared = (await seizePrepareRes.json()) as PreparedTransactionResponse;
    expect(seizePrepared.data.transaction.type).toBe("seize");
    expect(seizePrepared.data.preparedTransaction.serialized).toBeTruthy();

    const forceBurnPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/force-burn/prepare`, {
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
    expect(forceBurnPrepareRes.status).toBe(200);
    const forceBurnPrepared = (await forceBurnPrepareRes.json()) as PreparedTransactionResponse;
    expect(forceBurnPrepared.data.transaction.type).toBe("force_burn");
    expect(forceBurnPrepared.data.preparedTransaction.serialized).toBeTruthy();

    const authorityPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/authority/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        authority: {
          role: "mint",
          newAuthority: TEST_WALLETS.wallet2,
        },
      }),
    });
    expect(authorityPrepareRes.status).toBe(200);
    const authorityPrepared = (await authorityPrepareRes.json()) as PreparedTransactionResponse;
    expect(authorityPrepared.data.transaction.type).toBe("update_authority");
    expect(authorityPrepared.data.preparedTransaction.serialized).toBeTruthy();

    const pendingTransactionsRes = await request(
      `/v1/issuance/tokens/${tokenId}/transactions?status=pending&page=1&pageSize=20`
    );
    expect(pendingTransactionsRes.status).toBe(200);
    const pendingTransactions = (await pendingTransactionsRes.json()) as TransactionListResponse;
    expect(pendingTransactions.meta.total).toBeGreaterThanOrEqual(5);

    const pendingTypes = new Set(pendingTransactions.data.map((tx) => tx.type));
    expect(pendingTypes.has("mint")).toBe(true);
    expect(pendingTypes.has("burn")).toBe(true);
    expect(pendingTypes.has("seize")).toBe(true);
    expect(pendingTypes.has("force_burn")).toBe(true);
    expect(pendingTypes.has("update_authority")).toBe(true);
  });

  it("covers execute endpoints, frozen-account endpoints, confirmed history, and supply refresh", {
    timeout: 300000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin("Issuance Execute Coverage", "ISEXEC");
    const sourceTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet1, "4");
    const destinationTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet2, "1");
    await mintToWallet(tokenId, custodyAddress, "1");

    const pauseRes = await request(`/v1/issuance/tokens/${tokenId}/pause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as ExecuteTransactionResponse;
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
    const unpaused = (await unpauseRes.json()) as ExecuteTransactionResponse;
    expect(unpaused.data.transaction.type).toBe("unpause");
    expect(unpaused.data.transaction.status).toBe("confirmed");
    expect(unpaused.data.transaction.signature).toBeTruthy();

    const activeTokenRes = await request(`/v1/issuance/tokens/${tokenId}`);
    expect(activeTokenRes.status).toBe(200);
    const activeToken = (await activeTokenRes.json()) as TokenApiResponse;
    expect(activeToken.data.token.status).toBe("active");

    const freezeRes = await request(`/v1/issuance/tokens/${tokenId}/freeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: sourceTokenAccount,
        reason: "Coverage freeze",
      }),
    });
    expect(freezeRes.status).toBe(201);
    const frozen = (await freezeRes.json()) as {
      data: { frozenAccount: { accountAddress: string; signature?: string } };
    };
    expect(frozen.data.frozenAccount.accountAddress).toBe(sourceTokenAccount);
    expect(frozen.data.frozenAccount.signature).toBeTruthy();

    const frozenListRes = await request(`/v1/issuance/tokens/${tokenId}/frozen?page=1&pageSize=10`);
    expect(frozenListRes.status).toBe(200);
    const frozenListBody = (await frozenListRes.json()) as {
      data: Array<{ accountAddress: string }>;
      meta: { total: number };
    };
    expect(frozenListBody.meta.total).toBeGreaterThanOrEqual(1);
    expect(frozenListBody.data.some((entry) => entry.accountAddress === sourceTokenAccount)).toBe(
      true
    );

    const unfreezeRes = await request(`/v1/issuance/tokens/${tokenId}/unfreeze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountAddress: sourceTokenAccount,
      }),
    });
    expect(unfreezeRes.status).toBe(200);
    const unfrozen = (await unfreezeRes.json()) as {
      data: { frozenAccount: { accountAddress: string; signature?: string } };
    };
    expect(unfrozen.data.frozenAccount.accountAddress).toBe(sourceTokenAccount);
    expect(unfrozen.data.frozenAccount.signature).toBeTruthy();

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
    const burned = (await burnRes.json()) as ExecuteTransactionResponse;
    expect(burned.data.transaction.type).toBe("burn");
    expect(burned.data.transaction.status).toBe("confirmed");
    expect(burned.data.transaction.signature).toBeTruthy();

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
    const seized = (await seizeRes.json()) as ExecuteTransactionResponse;
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
    const forceBurned = (await forceBurnRes.json()) as ExecuteTransactionResponse;
    expect(forceBurned.data.transaction.type).toBe("force_burn");
    expect(forceBurned.data.transaction.status).toBe("confirmed");
    expect(forceBurned.data.transaction.signature).toBeTruthy();

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
    const authorityUpdated = (await authorityRes.json()) as ExecuteTransactionResponse;
    expect(authorityUpdated.data.transaction.type).toBe("update_authority");
    expect(authorityUpdated.data.transaction.status).toBe("confirmed");
    expect(authorityUpdated.data.transaction.signature).toBeTruthy();

    const refreshSupplyRes = await request(`/v1/issuance/tokens/${tokenId}/supply/refresh`, {
      method: "POST",
    });
    expect(refreshSupplyRes.status).toBe(200);
    const refreshed = (await refreshSupplyRes.json()) as TokenApiResponse;
    expect(refreshed.data.token.totalSupply).toBe("4");

    const confirmedTransactionsRes = await request(
      `/v1/issuance/tokens/${tokenId}/transactions?status=confirmed&page=1&pageSize=50`
    );
    expect(confirmedTransactionsRes.status).toBe(200);
    const confirmedTransactions =
      (await confirmedTransactionsRes.json()) as TransactionListResponse;
    expect(confirmedTransactions.meta.total).toBeGreaterThanOrEqual(10);

    const confirmedTypes = new Set(confirmedTransactions.data.map((tx) => tx.type));
    expect(confirmedTypes.has("mint")).toBe(true);
    expect(confirmedTypes.has("freeze")).toBe(true);
    expect(confirmedTypes.has("unfreeze")).toBe(true);
    expect(confirmedTypes.has("burn")).toBe(true);
    expect(confirmedTypes.has("pause")).toBe(true);
    expect(confirmedTypes.has("unpause")).toBe(true);
    expect(confirmedTypes.has("seize")).toBe(true);
    expect(confirmedTypes.has("force_burn")).toBe(true);
    expect(confirmedTypes.has("update_authority")).toBe(true);
  });
});
