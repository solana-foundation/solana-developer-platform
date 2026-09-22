import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RampOfframpQuoteInput, RampOnrampQuoteInput, RampRuntimeContext } from "../../types";
import { MoneygramRampClient } from "./client";

const SOURCE_WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
const DEPOSIT_WALLET = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";

const runtimeContext = {
  env: { MONEYGRAM_SANDBOX_SECRET_KEY: "mg_sk_test" },
  mode: "sandbox",
} satisfies RampRuntimeContext;

const offrampInput: RampOfframpQuoteInput = {
  paymentTransferId: "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  externalCustomerId: "cpty_mg_offramp_1",
  sourceWalletAddress: SOURCE_WALLET,
  assetRail: "usdc.solana",
  fiatCurrency: "USD",
  cryptoAmount: "25",
};

const onrampInput: RampOnrampQuoteInput = {
  paymentTransferId: "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  externalCustomerId: "cpty_mg_onramp_1",
  destinationWalletAddress: DEPOSIT_WALLET,
  assetRail: "usdc.solana",
  fiatCurrency: "USD",
  fiatAmount: "25",
};

function sessionFixture() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  return {
    sessionToken: `header.${payload}.sig`,
    sessionId: "mg_session_1",
    widgetUrl: "https://playground.xramps.moneygram.com/widget?mode=off-ramp",
    walletType: "custodial",
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MoneygramRampClient custodial sessions", () => {
  it("posts the customer and source wallet for an off-ramp widget", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(init);
      requests.push({ url: String(input), init });
      return Response.json(sessionFixture());
    };

    const quote = await new MoneygramRampClient().createOfframpQuote(runtimeContext, offrampInput);

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.url, "https://playground.xramps.moneygram.com/api/v1/sessions");
    assert.equal(request.init.method, "POST");
    assert.equal(new Headers(request.init.headers).get("x-api-key"), "mg_sk_test");
    assert.equal(typeof request.init.body, "string");
    assert.deepEqual(JSON.parse(String(request.init.body)), {
      customerIdentifier: offrampInput.externalCustomerId,
      walletAddress: offrampInput.sourceWalletAddress,
      chain: "solana",
      walletTransactionId: "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    });
    assert.ok(quote.provider === "moneygram");
    assert.ok(quote.widgetUrl);
    assert.equal(new URL(quote.widgetUrl).searchParams.get("mode"), "off-ramp");
  });

  it("posts the destination wallet and rewrites the widget to on-ramp", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = async (_input, init) => {
      assert.ok(init);
      requests.push(init);
      return Response.json(sessionFixture());
    };

    const quote = await new MoneygramRampClient().createOnrampQuote(runtimeContext, onrampInput);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].body)), {
      customerIdentifier: onrampInput.externalCustomerId,
      walletAddress: onrampInput.destinationWalletAddress,
      chain: "solana",
      walletTransactionId: "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    });
    assert.ok(quote.provider === "moneygram");
    assert.ok(quote.widgetUrl);
    assert.equal(new URL(quote.widgetUrl).searchParams.get("mode"), "on-ramp");
  });

  it("throws when paymentTransferId is missing", async () => {
    const { paymentTransferId: offTransferId, ...offrampWithoutTransfer } = offrampInput;
    const { paymentTransferId: onTransferId, ...onrampWithoutTransfer } = onrampInput;
    assert.ok(offTransferId);
    assert.ok(onTransferId);
    globalThis.fetch = async () => {
      assert.fail("A session must not be requested without a payment transfer id");
    };

    const client = new MoneygramRampClient();
    await assert.rejects(
      client.createOfframpQuote(runtimeContext, offrampWithoutTransfer),
      /require the SDP payment transfer id/
    );
    await assert.rejects(
      client.createOnrampQuote(runtimeContext, onrampWithoutTransfer),
      /require the SDP payment transfer id/
    );
  });

  it("rejects a session without walletType", async () => {
    const { sessionId, sessionToken, widgetUrl } = sessionFixture();
    globalThis.fetch = async () => Response.json({ sessionId, sessionToken, widgetUrl });

    await assert.rejects(
      new MoneygramRampClient().createOnrampQuote(runtimeContext, onrampInput),
      /MoneyGram session response is malformed/
    );
  });
});

describe("MoneygramRampClient.findOwnedTransaction", () => {
  const ownership = {
    transactionId: "mg_tx_owned_1",
    customerIdentifier: "cpty_mg_1",
  };
  const ownedTransaction = {
    transactionId: ownership.transactionId,
    customerIdentifier: ownership.customerIdentifier,
    partnerTransactionId: "mg_partner_transaction_1",
    mgiProfileId: "mg_profile_1",
    transactionType: "cash-in",
    sendAsset: "USDC",
    sendChain: "solana",
    settlementAccount: DEPOSIT_WALLET,
    kycData: { firstName: "Test" },
  };
  const transactions = [
    {
      ...ownedTransaction,
      transactionId: "mg_tx_other_customer_1",
      customerIdentifier: "cpty_mg_other_1",
    },
    {
      ...ownedTransaction,
      transactionId: "mg_tx_uncommitted_1",
      mgiProfileId: null,
      settlementAccount: null,
      transactionType: "cash-out",
    },
    ownedTransaction,
  ];

  it("returns only the owned transaction profile and direction", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(init);
      requests.push({ url: String(input), init });
      return Response.json({ transactions });
    };

    assert.deepEqual(
      await new MoneygramRampClient().findOwnedTransaction(runtimeContext, ownership),
      { profileId: "mg_profile_1", transactionType: "cash-in" }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://playground.xramps.moneygram.com/api/v1/transactions");
    assert.ok(requests[0].init.signal instanceof AbortSignal);
    assert.equal(requests[0].init.signal.aborted, false);
    assert.equal(requests[0].init.method, "GET");
    assert.equal(new Headers(requests[0].init.headers).get("x-api-key"), "mg_sk_test");
  });

  for (const [name, input] of [
    [
      "the same id belongs to another customer",
      { ...ownership, customerIdentifier: "cpty_mg_other_1" },
    ],
    ["the transaction id is unknown", { ...ownership, transactionId: "mg_tx_unknown_1" }],
  ] satisfies [string, typeof ownership][]) {
    it(`returns null when ${name}`, async () => {
      globalThis.fetch = async () => Response.json({ transactions });

      assert.equal(
        await new MoneygramRampClient().findOwnedTransaction(runtimeContext, input),
        null
      );
    });
  }

  it("parses an owned item without settlementAccount or partnerTransactionId", async () => {
    const {
      transactionId,
      customerIdentifier,
      mgiProfileId,
      transactionType,
      sendAsset,
      sendChain,
    } = ownedTransaction;
    globalThis.fetch = async () =>
      Response.json({
        transactions: [
          {
            transactionId,
            customerIdentifier,
            mgiProfileId,
            transactionType,
            sendAsset,
            sendChain,
          },
        ],
      });

    assert.deepEqual(
      await new MoneygramRampClient().findOwnedTransaction(runtimeContext, ownership),
      { profileId: "mg_profile_1", transactionType: "cash-in" }
    );
  });

  it("rejects an owned transaction on Stellar", async () => {
    globalThis.fetch = async () =>
      Response.json({
        transactions: [{ ...ownedTransaction, sendChain: "stellar" }],
      });

    await assert.rejects(
      new MoneygramRampClient().findOwnedTransaction(runtimeContext, ownership),
      /not USDC on Solana/
    );
  });

  it("rejects an owned transaction with no customer profile", async () => {
    globalThis.fetch = async () =>
      Response.json({
        transactions: [{ ...ownedTransaction, mgiProfileId: null }],
      });

    await assert.rejects(
      new MoneygramRampClient().findOwnedTransaction(runtimeContext, ownership),
      /no customer profile/
    );
  });

  it("rejects a malformed transaction list", async () => {
    globalThis.fetch = async () =>
      Response.json({ transactions: [{ transactionId: "mg_tx_owned_1" }] });

    await assert.rejects(
      new MoneygramRampClient().findOwnedTransaction(runtimeContext, ownership),
      /malformed/
    );
  });
});

describe("MoneygramRampClient.getAwaitingDeposit", () => {
  it("returns the awaiting USDC deposit instruction with its memo", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(init);
      requests.push({ url: String(input), init });
      return Response.json({
        status: "awaiting_funds",
        asset: "USDC",
        depositAddress: DEPOSIT_WALLET,
        sendAmount: "25",
        depositMemo: "mg_memo_1",
      });
    };

    const deposit = await new MoneygramRampClient().getAwaitingDeposit(
      runtimeContext,
      "mg_tx_created_1"
    );

    assert.deepEqual(deposit, {
      depositAddress: DEPOSIT_WALLET,
      sendAmount: "25",
      depositMemo: "mg_memo_1",
    });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://playground.xramps.moneygram.com/api/v1/transactions/mg_tx_created_1/status"
    );
    assert.equal(requests[0].init.method, "GET");
    assert.equal(new Headers(requests[0].init.headers).get("x-api-key"), "mg_sk_test");
  });

  it("omits the memo when MoneyGram supplies none", async () => {
    globalThis.fetch = async () =>
      Response.json({
        status: "awaiting_funds",
        asset: "USDC",
        depositAddress: DEPOSIT_WALLET,
        sendAmount: "25",
      });

    assert.deepEqual(
      await new MoneygramRampClient().getAwaitingDeposit(runtimeContext, "mg_tx_created_1"),
      {
        depositAddress: DEPOSIT_WALLET,
        sendAmount: "25",
      }
    );
  });

  it("rejects a transaction that is not awaiting funds", async () => {
    globalThis.fetch = async () =>
      Response.json({
        status: "completed",
        asset: "USDC",
        depositAddress: DEPOSIT_WALLET,
        sendAmount: "25",
      });

    await assert.rejects(
      new MoneygramRampClient().getAwaitingDeposit(runtimeContext, "mg_tx_created_1"),
      /not awaiting funds/
    );
  });

  it("rejects a deposit for an asset other than USDC", async () => {
    globalThis.fetch = async () =>
      Response.json({
        status: "awaiting_funds",
        asset: "USDT",
        depositAddress: DEPOSIT_WALLET,
        sendAmount: "25",
      });

    await assert.rejects(
      new MoneygramRampClient().getAwaitingDeposit(runtimeContext, "mg_tx_created_1"),
      /not USDC/
    );
  });

  it("rejects a transaction without a deposit address", async () => {
    globalThis.fetch = async () =>
      Response.json({
        status: "awaiting_funds",
        asset: "USDC",
        sendAmount: "25",
      });

    await assert.rejects(
      new MoneygramRampClient().getAwaitingDeposit(runtimeContext, "mg_tx_created_1"),
      /no deposit instruction yet/
    );
  });
});
