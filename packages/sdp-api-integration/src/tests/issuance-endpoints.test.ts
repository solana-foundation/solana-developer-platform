import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MintApiResponse, TokenApiResponse, TransactionRecord } from "../helpers/api-types";
import {
  RUN_INTEGRATION_TESTS,
  SOLANA_CONFIGURED,
  cleanupIntegrationSuite,
  initIntegrationSuite,
  requestWithApiKey,
  resetIntegrationState,
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
  // biome-ignore lint/nursery/noSecrets: Test Solana address.
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  // biome-ignore lint/nursery/noSecrets: Test Solana address.
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
    await resetIntegrationState(apiKeyHash);
  });

  const createAndDeployStablecoin = async (name: string, symbol: string) => {
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stablecoinPayload(name, symbol)),
    });
    expect(createRes.status).toBe(201);

    const created = (await createRes.json()) as TokenApiResponse;
    const tokenId = created.data.token.id;

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

  it("covers prepare endpoints and pending transaction history", { timeout: 180000 }, async () => {
    const tokenId = await createAndDeployStablecoin("Issuance Prepare Coverage", "ISPREP");
    const sourceTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet1, "3");
    const destinationTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet2, "1");

    const burnPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/burn/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        burn: {
          source: sourceTokenAccount,
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
    expect(pendingTransactions.meta.total).toBeGreaterThanOrEqual(4);

    const pendingTypes = new Set(pendingTransactions.data.map((tx) => tx.type));
    expect(pendingTypes.has("burn")).toBe(true);
    expect(pendingTypes.has("seize")).toBe(true);
    expect(pendingTypes.has("force_burn")).toBe(true);
    expect(pendingTypes.has("update_authority")).toBe(true);
  });

  it(
    "covers execute endpoints, confirmed history, and supply refresh",
    { timeout: 240000 },
    async () => {
      const tokenId = await createAndDeployStablecoin("Issuance Execute Coverage", "ISEXEC");
      const sourceTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet1, "4");
      const destinationTokenAccount = await mintToWallet(tokenId, TEST_WALLETS.wallet2, "1");

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
        `/v1/issuance/tokens/${tokenId}/transactions?status=confirmed&page=1&pageSize=30`
      );
      expect(confirmedTransactionsRes.status).toBe(200);
      const confirmedTransactions =
        (await confirmedTransactionsRes.json()) as TransactionListResponse;
      expect(confirmedTransactions.meta.total).toBeGreaterThanOrEqual(7);

      const confirmedTypes = new Set(confirmedTransactions.data.map((tx) => tx.type));
      expect(confirmedTypes.has("pause")).toBe(true);
      expect(confirmedTypes.has("unpause")).toBe(true);
      expect(confirmedTypes.has("seize")).toBe(true);
      expect(confirmedTypes.has("force_burn")).toBe(true);
      expect(confirmedTypes.has("update_authority")).toBe(true);
    }
  );
});
