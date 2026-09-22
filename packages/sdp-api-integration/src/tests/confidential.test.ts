import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenApiResponse, TransactionRecord } from "../helpers/api-types";
import {
  CONFIDENTIAL_MINT_BURN_SUPPORTED,
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
      // How many transactions a transfer takes depends on the transaction
      // version — three or more at version 0, often one at version 1 — so assert
      // the contract rather than the count: when there was more than one, every
      // signature is journaled for the context-state accounts they created.
      const planSignatures = (
        transfer.json.data.transaction.params as { planSignatures?: string[] } | null
      )?.planSignatures;
      if (planSignatures) {
        expect(planSignatures.length).toBeGreaterThan(1);
        expect(planSignatures.at(-1)).toBe(transfer.json.data.transaction.signature);
      }

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

/**
 * Confidential mint/burn: a mint whose total supply exists only as a ciphertext.
 *
 * Skipped wherever transaction v1 and the mint/burn proofs are not served —
 * Surfpool is a simnet on an older Agave than SIMD-0385 needs, so the shard that
 * runs there covers the seven balance operations at transaction version 0 and
 * this block is devnet-only.
 */
describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS || !CONFIDENTIAL_MINT_BURN_SUPPORTED)(
  "Confidential mint/burn",
  () => {
    const request = requestWithApiKey();
    let custodyAddress = "";
    let custodyWalletId = "";
    let supplyWalletAddress = "";
    let supplyWalletId = "";
    let tokenId = "";

    const post = async (path: string, body: unknown) => {
      const res = await request(`/v1/issuance/tokens/${tokenId}${path}`, {
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

      // A dedicated wallet, holding no confidential balances of its own: its keys
      // protect the mint's whole supply, and derivation is wallet-only, so those
      // are the same keys that would guard its own balances.
      const supplyWallet = await createFundedIntegrationWallet({ label: "confidential-supply" });
      supplyWalletAddress = supplyWallet.publicKey;
      supplyWalletId = supplyWallet.id;

      const createRes = await request("/v1/issuance/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Encrypted Supply Token",
          symbol: "ESUP",
          decimals: 6,
          isMintable: true,
          template: "custom",
          overrides: {
            extensions: {
              confidentialTransfers: { policy: "opt-in" },
              confidentialMintBurn: { supplyAuthority: supplyWalletAddress },
            },
          },
        }),
      });
      expect(createRes.status).toBe(201);
      tokenId = ((await createRes.json()) as TokenApiResponse).data.token.id;

      const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signingCustodyWalletId: custodyWalletId }),
      });
      expect(deployRes.status).toBe(200);
    }, 180000);

    afterAll(async () => {
      await cleanupIntegrationSuite();
    });

    it("issues and redeems supply without revealing an amount", { timeout: 300000 }, async () => {
      const configure = await post("/confidential/configure", { walletAddress: custodyAddress });
      expect(configure.res.status).toBe(200);

      const minted = await post("/confidential/mint", {
        destination: custodyAddress,
        amount: "500",
        signingCustodyWalletId: custodyWalletId,
        supplyCustodyWalletId: supplyWalletId,
      });
      expect(minted.res.status).toBe(200);
      expect(minted.json.data.transaction.status).toBe("confirmed");

      // The minted amount lands in the pending balance, exactly like a deposit.
      await post("/confidential/apply-pending", { walletAddress: custodyAddress });

      const afterMintRes = await request(
        `/v1/issuance/tokens/${tokenId}/confidential/balance?walletAddress=${custodyAddress}`
      );
      const afterMint = (await afterMintRes.json()) as ConfidentialBalanceResponse;
      expect(afterMint.data.confidentialBalance.availableBalance).toBe("500000000");

      const burned = await post("/confidential/burn", {
        walletAddress: custodyAddress,
        amount: "200",
        signingCustodyWalletId: custodyWalletId,
      });
      expect(burned.res.status).toBe(200);
      expect(burned.json.data.transaction.status).toBe("confirmed");

      const applyBurn = await post("/confidential/apply-pending-burn", {
        signingCustodyWalletId: custodyWalletId,
        supplyCustodyWalletId: supplyWalletId,
      });
      expect(applyBurn.res.status).toBe(200);
      expect(applyBurn.json.data.transaction.status).toBe("confirmed");

      const afterBurnRes = await request(
        `/v1/issuance/tokens/${tokenId}/confidential/balance?walletAddress=${custodyAddress}`
      );
      const afterBurn = (await afterBurnRes.json()) as ConfidentialBalanceResponse;
      expect(afterBurn.data.confidentialBalance.availableBalance).toBe("300000000");

      // The real assertion: a second mint only succeeds if the decryptable supply
      // was re-asserted correctly during the apply, since its proof is built
      // against that value.
      const remint = await post("/confidential/mint", {
        destination: custodyAddress,
        amount: "100",
        signingCustodyWalletId: custodyWalletId,
        supplyCustodyWalletId: supplyWalletId,
      });
      expect(remint.res.status).toBe(200);
      expect(remint.json.data.transaction.status).toBe("confirmed");
    });

    // These fail before any transaction is built, so they assert the preflight
    // rather than an on-chain rejection.
    it("refuses the conversion operations a mint-burn mint has no side for", async () => {
      const deposit = await post("/confidential/deposit", {
        walletAddress: custodyAddress,
        amount: "1",
      });
      expect(deposit.res.status).toBe(400);

      const withdraw = await post("/confidential/withdraw", {
        walletAddress: custodyAddress,
        amount: "1",
      });
      expect(withdraw.res.status).toBe(400);

      const plaintextMint = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signingCustodyWalletId: custodyWalletId,
          mint: { destination: custodyAddress, amount: "1" },
        }),
      });
      expect(plaintextMint.status).toBe(400);
    });
  }
);
