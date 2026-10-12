/* biome-ignore-all lint/security/noSecrets: Public Solana mint/program/account fixture addresses; no private keys. */
import assert from "node:assert/strict";
import { getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";

// This preload controls external boundaries only; HTTP authorization and Postgres stay real.
const database = new URL(process.env.DATABASE_URL);
assert(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.port === "15452" &&
    database.pathname === "/sdp_payments_pr2_8996"
);
assert.equal(process.env.SOLANA_RPC_URL, "http://127.0.0.1:9922");
assert.equal(process.env.PLAYWRIGHT_PAYMENTS_EXACT_IDENTITY, "1");
const { SigningService } = await import("../../../sdp-api/src/services/domain/signing.service.ts");
const realSigner = SigningService.prototype.getTransactionSignerForWalletRecord;
SigningService.prototype.getTransactionSignerForWalletRecord = function (
  orgId,
  projectId,
  walletId
) {
  // The explicit fixture alias shares the local key; real HTTP/runtime admission runs before this provider seam.
  const target = walletId.startsWith("cwlt_pr2_alias_")
    ? walletId.slice("cwlt_pr2_alias_".length)
    : walletId;
  return realSigner.call(this, orgId, projectId, target);
};

const originalFetch = globalThis.fetch;
const sessions = new Map();
const usdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const tokenAccount = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";
const json = (value) => Response.json(value);

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    url.origin !== process.env.SOLANA_RPC_URL &&
    url.hostname !== "playground.xramps.moneygram.com"
  ) {
    return originalFetch(input, init);
  }
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
  const payload = body ? JSON.parse(body) : {};
  if (url.origin === process.env.SOLANA_RPC_URL) {
    let result;
    switch (payload.method) {
      case "sendTransaction":
        result = getSignatureFromTransaction(
          getTransactionDecoder().decode(Buffer.from(payload.params[0], "base64"))
        );
        break;
      case "simulateTransaction":
        result = {
          context: { slot: 1 },
          value: { err: null, logs: [], unitsConsumed: 5000, returnData: null, accounts: null },
        };
        break;
      case "getSignatureStatuses":
        result = {
          context: { slot: 1 },
          value: payload.params[0].map(() => ({
            slot: 1,
            confirmations: null,
            err: null,
            confirmationStatus: "confirmed",
          })),
        };
        break;
      case "getSlot":
      case "getBlockHeight":
        result = 1;
        break;
      case "getBalance":
        result = { context: { slot: 1 }, value: 100_000_000_000 };
        break;
      case "getMultipleAccounts":
        assert.deepEqual(payload.params[1].dataSlice, { offset: 0, length: 0 });
        assert.equal(payload.params[1].encoding, "base64");
        result = {
          context: { slot: 1 },
          value: payload.params[0].map(() => ({
            data: ["", "base64"],
            executable: false,
            lamports: 100_000_000_000,
            owner: "11111111111111111111111111111111",
            rentEpoch: 0,
            space: 0,
          })),
        };
        break;
      case "getTokenAccountsByOwner":
        result = {
          context: { slot: 1 },
          value: [
            {
              pubkey: tokenAccount,
              account: {
                executable: false,
                lamports: 2039280,
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                rentEpoch: 0,
                space: 165,
                data: {
                  program: "spl-token",
                  parsed: {
                    type: "account",
                    info: {
                      mint: usdc,
                      owner: payload.params[0],
                      tokenAmount: {
                        amount: "1000000000",
                        decimals: 6,
                        uiAmount: 1000,
                        uiAmountString: "1000",
                      },
                    },
                  },
                  space: 165,
                },
              },
            },
          ],
        };
        break;
      case "getSignaturesForAddress":
        result = [];
        break;
      case "getLatestBlockhash":
        result = {
          context: { slot: 1 },
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 999999,
          },
        };
        break;
      case "getFeeForMessage":
        result = { context: { slot: 1 }, value: 5000 };
        break;
      case "getTokenSupply":
        result = {
          context: { slot: 1 },
          value: {
            amount: "1000000000",
            decimals: 6,
            uiAmount: 1000,
            uiAmountString: "1000",
          },
        };
        break;
      case "getAccountInfo":
        result = { context: { slot: 1 }, value: null };
        break;
      case "getTransaction":
        result = null;
        break;
      default:
        throw new Error(`Unsupported Payments E2E RPC method: ${payload.method}`);
    }
    return json({ jsonrpc: "2.0", id: payload.id, result });
  }
  if (url.pathname === "/api/v1/currencies")
    return json([
      { code: "USD", type: "fiat" },
      { code: "USDC", type: "crypto" },
    ]);
  if (url.pathname === "/api/v1/sessions") {
    sessions.set(payload.walletTransactionId, payload.customerIdentifier);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return json({
      sessionId: `mg_e2e_${payload.walletTransactionId}`,
      sessionToken: `${encode({ alg: "HS256" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`,
      widgetUrl: "https://playground.xramps.moneygram.com/widget",
      walletType: "custodial",
    });
  }
  if (url.pathname === "/api/v1/crypto/withdraw/estimateQuoteWithFee") {
    const amount = Number(url.searchParams.get("amount"));
    return json({
      sendAmountDetails: {
        partnerFees: { value: 0, currencyCode: "USDC" },
        totalAmount: { value: amount, currencyCode: "USDC" },
      },
      payoutAmountDetails: { fxRate: 1, totalAmount: { value: amount, currencyCode: "USD" } },
    });
  }
  if (url.pathname === "/api/v1/transactions")
    return json({
      transactions: [...sessions].map(([id, customerIdentifier]) => ({
        transactionId: `mg_tx_${id}`,
        customerIdentifier,
        mgiProfileId: "mg_e2e_profile",
        transactionType: "cash-out",
        sendAsset: "USDC",
        sendChain: "solana",
      })),
    });
  if (/^\/api\/v1\/transactions\/mg_tx_[^/]+\/status$/.test(url.pathname))
    return json({
      status: "awaiting_funds",
      asset: "USDC",
      depositAddress: tokenAccount,
      sendAmount: "25",
    });
  throw new Error(`Unsupported Payments E2E MoneyGram path: ${url.pathname}`);
};
