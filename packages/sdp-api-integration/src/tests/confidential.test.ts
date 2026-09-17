import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenApiResponse, TransactionRecord } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  INTEGRATION_CUSTODY_PROVIDER,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";

interface ConfidentialOperationResponse {
  data: { transaction: TransactionRecord };
}

interface ConfidentialBalanceResponse {
  data: {
    confidentialBalance: {
      tokenAccount: string;
      walletAddress: string;
      approved: boolean;
      availableBalance: string | null;
      pendingBalance: string | null;
    };
  };
}

// Local custody hands every wallet the same signing key, so a "second holder"
// resolves to the same address and the same token account — there is no second
// side to transfer to. The rest of the lifecycle is provider-independent.
const CAN_USE_TWO_HOLDERS = INTEGRATION_CUSTODY_PROVIDER !== "local";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Confidential Transfers", () => {
  const request = requestWithApiKey();
  let custodyAddress = "";
  let custodyWalletId = "";
  let deployedTokenId = "";

  const post = async (path: string, body: unknown) => {
    const res = await request(`/v1/issuance/tokens/${deployedTokenId}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: (await res.json()) as ConfidentialOperationResponse };
  };

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    const state = await resetIntegrationState(init.apiKeyHash);
    custodyAddress = state.custodyAddress;
    custodyWalletId = state.custodyWallet.id;

    // opt-in policy so no separate approve step is needed; the extension can
    // only be added at creation, never afterwards.
    const createRes = await request("/v1/issuance/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Confidential Test Token",
        symbol: "CONF",
        decimals: 6,
        isMintable: true,
        template: "custom",
        // Extensions travel under `overrides`; a top-level `extensions` key is
        // stripped by the schema and the mint comes out without it.
        overrides: { extensions: { confidentialTransfers: { policy: "opt-in" } } },
      }),
    });
    expect(createRes.status).toBe(201);
    deployedTokenId = ((await createRes.json()) as TokenApiResponse).data.token.id;

    const deployRes = await request(`/v1/issuance/tokens/${deployedTokenId}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingCustodyWalletId: custodyWalletId }),
    });
    expect(deployRes.status).toBe(200);

    const mintRes = await request(`/v1/issuance/tokens/${deployedTokenId}/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signingCustodyWalletId: custodyWalletId,
        mint: { destination: custodyAddress, amount: "1000" },
      }),
    });
    expect(mintRes.status).toBe(200);
    await mintRes.json();
  }, 180000);

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  it("runs the full single-holder lifecycle", { timeout: 300000 }, async () => {
    // Configure spans several transactions (proof context setup → configure →
    // cleanup) and must settle on the last one.
    const configure = await post("/confidential/configure", {
      walletAddress: custodyAddress,
    });
    expect(configure.res.status).toBe(200);
    expect(configure.json.data.transaction.status).toBe("confirmed");
    expect(configure.json.data.transaction.signature).toBeTruthy();

    const deposit = await post("/confidential/deposit", {
      walletAddress: custodyAddress,
      amount: "600",
    });
    expect(deposit.res.status).toBe(200);
    expect(deposit.json.data.transaction.status).toBe("confirmed");

    const applied = await post("/confidential/apply-pending", {
      walletAddress: custodyAddress,
    });
    expect(applied.res.status).toBe(200);

    const balanceRes = await request(
      `/v1/issuance/tokens/${deployedTokenId}/confidential/balance?walletAddress=${custodyAddress}`
    );
    expect(balanceRes.status).toBe(200);
    const balance = (await balanceRes.json()) as ConfidentialBalanceResponse;
    expect(balance.data.confidentialBalance.approved).toBe(true);
    // 600 tokens at 6 decimals, decrypted from the ElGamal/AES ciphertext.
    expect(balance.data.confidentialBalance.availableBalance).toBe("600000000");

    // The PoC built withdraw and empty-account but never ran them end to end.
    const withdraw = await post("/confidential/withdraw", {
      walletAddress: custodyAddress,
      amount: "600",
    });
    expect(withdraw.res.status).toBe(200);
    expect(withdraw.json.data.transaction.status).toBe("confirmed");

    const drained = await request(
      `/v1/issuance/tokens/${deployedTokenId}/confidential/balance?walletAddress=${custodyAddress}`
    );
    const drainedBalance = (await drained.json()) as ConfidentialBalanceResponse;
    expect(drainedBalance.data.confidentialBalance.availableBalance).toBe("0");

    // Empty only succeeds once the available balance is already zero.
    const emptied = await post("/confidential/empty", { walletAddress: custodyAddress });
    expect(emptied.res.status).toBe(200);
  });

  it.skipIf(!CAN_USE_TWO_HOLDERS)(
    "transfers an encrypted amount between two holders",
    { timeout: 300000 },
    async () => {
      const recipient = await createFundedIntegrationWallet({
        label: "confidential-recipient",
        fundLamports: 50_000_000,
      });

      await request(`/v1/issuance/tokens/${deployedTokenId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signingCustodyWalletId: custodyWalletId,
          mint: { destination: recipient.publicKey, amount: "1" },
        }),
      });

      await post("/confidential/configure", { walletAddress: recipient.publicKey });

      // The sender was configured by the lifecycle test above. Emptying an
      // account closes its balances but leaves the extension initialized, so a
      // second configure is a conflict, not a no-op.
      const reconfigure = await post("/confidential/configure", {
        walletAddress: custodyAddress,
      });
      expect(reconfigure.res.status).toBe(409);

      await post("/confidential/deposit", { walletAddress: custodyAddress, amount: "400" });
      await post("/confidential/apply-pending", { walletAddress: custodyAddress });

      const transfer = await post("/confidential/transfer", {
        walletAddress: custodyAddress,
        destination: recipient.publicKey,
        amount: "200",
      });
      expect(transfer.res.status).toBe(200);
      expect(transfer.json.data.transaction.status).toBe("confirmed");
      // Transfer is a multi-transaction plan: the settled signature is the last
      // one, and every signature is journaled for the context-state accounts.
      expect(transfer.json.data.transaction.params).toMatchObject({
        planSignatures: expect.any(Array),
      });

      await post("/confidential/apply-pending", { walletAddress: recipient.publicKey });

      const senderRes = await request(
        `/v1/issuance/tokens/${deployedTokenId}/confidential/balance?walletAddress=${custodyAddress}`
      );
      const sender = (await senderRes.json()) as ConfidentialBalanceResponse;
      expect(sender.data.confidentialBalance.availableBalance).toBe("200000000");

      const receiverRes = await request(
        `/v1/issuance/tokens/${deployedTokenId}/confidential/balance?walletAddress=${recipient.publicKey}`
      );
      const receiver = (await receiverRes.json()) as ConfidentialBalanceResponse;
      expect(receiver.data.confidentialBalance.availableBalance).toBe("200000000");
    }
  );
});
