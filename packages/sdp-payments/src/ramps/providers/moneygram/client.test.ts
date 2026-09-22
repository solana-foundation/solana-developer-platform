import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RampOfframpQuoteInput, RampOnrampQuoteInput } from "../../types";
import { MoneygramRampClient } from "./client";

const SOURCE_WALLET = "MgSourceWallet11111111111111111111111111111";
const DEPOSIT_WALLET = "MgDepositWallet1111111111111111111111111111";

const runtimeContext = {
  env: { MONEYGRAM_SANDBOX_SECRET_KEY: "mg_sk_test" },
  mode: "sandbox",
} as const;

const offrampInput: RampOfframpQuoteInput = {
  externalCustomerId: "cpty_mg_offramp_1",
  sourceWalletAddress: SOURCE_WALLET,
  assetRail: "usdc.solana",
  fiatCurrency: "USD",
  cryptoAmount: "25",
};

const onrampInput: RampOnrampQuoteInput = {
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
    });
    assert.ok(quote.provider === "moneygram");
    assert.ok(quote.widgetUrl);
    assert.equal(new URL(quote.widgetUrl).searchParams.get("mode"), "on-ramp");
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

describe("MoneygramRampClient.getCustomerProfileId", () => {
  it("mints a customer session and returns only the profile id from the authenticated profile lookup", async () => {
    const session = sessionFixture();
    const responses = [
      Response.json(session),
      Response.json({ profileId: "mg_profile_1", firstName: "Test", extraField: "test_value" }),
    ];
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(init);
      requests.push({ url: String(input), init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    };

    const profileId = await new MoneygramRampClient().getCustomerProfileId(
      runtimeContext,
      "cpty_mg_profile_1"
    );

    assert.equal(profileId, "mg_profile_1");
    assert.equal(requests.length, 2);
    assert.equal(responses.length, 0);
    const [sessionRequest, profileRequest] = requests;
    assert.equal(sessionRequest.url, "https://playground.xramps.moneygram.com/api/v1/sessions");
    assert.equal(sessionRequest.init.method, "POST");
    assert.equal(new Headers(sessionRequest.init.headers).get("x-api-key"), "mg_sk_test");
    assert.equal(typeof sessionRequest.init.body, "string");
    assert.deepEqual(JSON.parse(String(sessionRequest.init.body)), {
      customerIdentifier: "cpty_mg_profile_1",
      chain: "solana",
    });
    assert.equal(profileRequest.url, "https://playground.xramps.moneygram.com/api/v1/profiles/me");
    assert.equal(profileRequest.init.method, "GET");
    assert.equal(
      new Headers(profileRequest.init.headers).get("Authorization"),
      `Bearer ${session.sessionToken}`
    );
  });

  it("rejects a 204 response when the customer has no profile yet", async () => {
    const responses = [Response.json(sessionFixture()), new Response(null, { status: 204 })];
    globalThis.fetch = async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    };

    await assert.rejects(
      new MoneygramRampClient().getCustomerProfileId(runtimeContext, "cpty_mg_profile_1"),
      /no profile for this customer yet/
    );
    assert.equal(responses.length, 0);
  });

  it("rejects a 500 profile response", async () => {
    const responses = [
      Response.json(sessionFixture()),
      Response.json({ message: "Profile lookup failed" }, { status: 500 }),
    ];
    globalThis.fetch = async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    };

    await assert.rejects(
      new MoneygramRampClient().getCustomerProfileId(runtimeContext, "cpty_mg_profile_1"),
      /profile lookup failed with status 500/
    );
    assert.equal(responses.length, 0);
  });

  it("rejects a malformed profile response without profileId", async () => {
    const responses = [Response.json(sessionFixture()), Response.json({ firstName: "Test" })];
    globalThis.fetch = async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    };

    await assert.rejects(
      new MoneygramRampClient().getCustomerProfileId(runtimeContext, "cpty_mg_profile_1"),
      /malformed/
    );
    assert.equal(responses.length, 0);
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
