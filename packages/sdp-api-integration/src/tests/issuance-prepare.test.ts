import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DeployPrepareApiResponse,
  PreparedTransactionApiResponse,
  TransactionListApiResponse,
} from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";
import {
  createAndDeployStablecoin,
  createStablecoin,
  mintToWallet,
  TEST_WALLETS,
} from "../helpers/issuance";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Issuance Prepare Endpoints", () => {
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

  const prepareMint = async (tokenId: string) => {
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

    return (await mintPrepareRes.json()) as PreparedTransactionApiResponse;
  };

  const prepareAuthorityUpdate = async (tokenId: string) => {
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

    return (await authorityPrepareRes.json()) as PreparedTransactionApiResponse;
  };

  it("prepares a token deployment", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createStablecoin(request, "Deploy Prepare Coverage", "DPREP");

    const deployPrepareRes = await request(`/v1/issuance/tokens/${tokenId}/deploy/prepare`, {
      method: "POST",
    });
    expect(deployPrepareRes.status).toBe(200);
    const deployPrepared = (await deployPrepareRes.json()) as DeployPrepareApiResponse;
    expect(deployPrepared.data.transaction.serialized).toBeTruthy();
    expect(deployPrepared.data.transaction.blockhash).toBeTruthy();
    expect(deployPrepared.data.mint).toBeTruthy();
  });

  it("prepares a mint after deployment", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Mint Prepare Coverage", "MPREP");

    const mintPrepared = await prepareMint(tokenId);
    expect(mintPrepared.data.transaction.type).toBe("mint");
    expect(mintPrepared.data.preparedTransaction.serialized).toBeTruthy();
  });

  it("prepares burn, seize, and force-burn transactions", {
    timeout: 240000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(
      request,
      "Operations Prepare Coverage",
      "OPREP"
    );
    const sourceTokenAccount = await mintToWallet(request, tokenId, TEST_WALLETS.wallet1, "3");
    const destinationTokenAccount = await mintToWallet(request, tokenId, TEST_WALLETS.wallet2, "1");
    await mintToWallet(request, tokenId, custodyAddress, "1");

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
    const burnPrepared = (await burnPrepareRes.json()) as PreparedTransactionApiResponse;
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
    const seizePrepared = (await seizePrepareRes.json()) as PreparedTransactionApiResponse;
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
    const forceBurnPrepared = (await forceBurnPrepareRes.json()) as PreparedTransactionApiResponse;
    expect(forceBurnPrepared.data.transaction.type).toBe("force_burn");
    expect(forceBurnPrepared.data.preparedTransaction.serialized).toBeTruthy();
  });

  it("prepares an authority update", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Authority Prepare Coverage", "APREP");

    const authorityPrepared = await prepareAuthorityUpdate(tokenId);
    expect(authorityPrepared.data.transaction.type).toBe("update_authority");
    expect(authorityPrepared.data.preparedTransaction.serialized).toBeTruthy();
  });

  it("lists pending transaction history", {
    timeout: 180000,
  }, async () => {
    const tokenId = await createAndDeployStablecoin(request, "Pending History Coverage", "PHPREP");
    await prepareMint(tokenId);
    await prepareAuthorityUpdate(tokenId);

    const pendingTransactionsRes = await request(
      `/v1/issuance/tokens/${tokenId}/transactions?status=pending&page=1&pageSize=20`
    );
    expect(pendingTransactionsRes.status).toBe(200);
    const pendingTransactions = (await pendingTransactionsRes.json()) as TransactionListApiResponse;
    expect(pendingTransactions.meta.total).toBeGreaterThanOrEqual(2);

    const pendingTypes = new Set(pendingTransactions.data.map((transaction) => transaction.type));
    expect(pendingTypes.has("mint")).toBe(true);
    expect(pendingTypes.has("update_authority")).toBe(true);
    expect(pendingTransactions.data.every((transaction) => transaction.status === "pending")).toBe(
      true
    );
  });
});
