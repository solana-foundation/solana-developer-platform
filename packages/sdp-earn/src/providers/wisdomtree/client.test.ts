import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import { WISDOMTREE_FUNDS } from "@sdp/types/wisdomtree-programs";
import { supportsDepositEligibility, supportsPortfolioWallets } from "../../capabilities";
import { SdpEarnError, type SdpEarnErrorCode } from "../../errors";
import type { EarnRuntimeContext } from "../../types";
import { WisdomTreeEarnClient } from "./client";
import { resetWisdomTreeTokenCache } from "./connect";

/**
 * Canonical no-network harness (see src/fetch.test.ts): `globalThis.fetch` is
 * stubbed per test and restored in `afterEach` — no test may ever reach the
 * real WisdomTree Connect API.
 */

const client = new WisdomTreeEarnClient();

const WTGXX = WISDOMTREE_FUNDS[0];
const MAINNET_USDC = wellKnownMint("USDC", "mainnet-beta");

const credential = JSON.stringify({
  clientId: "client-id",
  clientSecret: "client-secret",
  username: "api-user",
  password: "api-pass",
});

const productionCtx: EarnRuntimeContext = {
  env: { WISDOMTREE_API_KEY: credential },
  environment: "production",
};
const sandboxCtx: EarnRuntimeContext = {
  env: { WISDOMTREE_SANDBOX_API_KEY: credential },
  environment: "sandbox",
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const tokenReply = { access_token: "bearer-token", expires_in: 600 };

/** Queue JSON replies; extra calls replay the last reply. */
function stubConnectFetch(...replies: Array<{ status?: number; body: unknown }>) {
  let index = 0;
  return mock.method(globalThis, "fetch", async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return jsonResponse(reply.status ?? 200, reply.body);
  });
}

type FetchMock = ReturnType<typeof stubConnectFetch>;

const requestUrl = (fetchMock: FetchMock, call = 0): string =>
  String(fetchMock.mock.calls[call].arguments[0]);

const earnError =
  (code: SdpEarnErrorCode, message?: RegExp) =>
  (error: unknown): boolean =>
    error instanceof SdpEarnError &&
    error.code === code &&
    (message === undefined || message.test(error.message));

beforeEach(() => {
  resetWisdomTreeTokenCache();
});

afterEach(() => {
  mock.restoreAll();
});

describe("capability shape", () => {
  it("reports deposit eligibility and nothing custodial", () => {
    assert.equal(supportsDepositEligibility(client), true);
    assert.equal(supportsPortfolioWallets(client), false);
  });
});

describe("listStrategies", () => {
  it("answers an empty shelf outside production without any network call", async () => {
    const fetchMock = stubConnectFetch({ body: {} });
    assert.deepEqual(await client.listStrategies(sandboxCtx), []);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("throws PROVIDER_NOT_CONFIGURED before any network call without a credential", async () => {
    const fetchMock = stubConnectFetch({ body: {} });
    await assert.rejects(
      client.listStrategies({ env: {}, environment: "production" }),
      earnError("PROVIDER_NOT_CONFIGURED", /WISDOMTREE_API_KEY/)
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("throws PROVIDER_NOT_CONFIGURED on a malformed packed credential", async () => {
    await assert.rejects(
      client.listStrategies({
        env: { WISDOMTREE_API_KEY: "not-json" },
        environment: "production",
      }),
      earnError("PROVIDER_NOT_CONFIGURED", /not valid JSON/)
    );
    await assert.rejects(
      client.listStrategies({
        env: { WISDOMTREE_API_KEY: JSON.stringify({ clientId: "only" }) },
        environment: "production",
      }),
      earnError("PROVIDER_NOT_CONFIGURED", /clientSecret/)
    );
    await assert.rejects(
      client.listStrategies({
        env: { WISDOMTREE_API_KEY: "null" },
        environment: "production",
      }),
      earnError("PROVIDER_NOT_CONFIGURED", /must be a JSON object/)
    );
  });

  it("maps a tradable registry fund onto a catalogue snapshot", async () => {
    const fetchMock = stubConnectFetch(
      { body: tokenReply },
      {
        body: {
          products: [
            { exchange_code: WTGXX.exchangeCode, can_trade: true, issuer: "WisdomTree" },
            { exchange_code: "SPXUX", can_trade: true },
          ],
        },
      }
    );

    const snapshots = await client.listStrategies(productionCtx);
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.deepEqual(snapshot, {
      providerReference: WTGXX.mint,
      name: WTGXX.name,
      sourceKind: "rwa",
      underlyingSource: "wtgxx",
      depositMints: [MAINNET_USDC],
      shareMint: WTGXX.mint,
      hostCluster: "mainnet-beta",
      apyType: "variable",
      liquidityTerm: "delayed",
      redemptionDelayDays: 1,
      riskMetadata: { curator: "wisdomtree" },
    });

    // OAuth password grant first, then the products read with the bearer token.
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.match(requestUrl(fetchMock, 0), /\/o\/token\/$/);
    assert.match(requestUrl(fetchMock, 1), /\/api\/orders\/products$/);
    const productsInit = fetchMock.mock.calls[1].arguments[1] as RequestInit;
    assert.equal(new Headers(productsInit.headers).get("authorization"), "Bearer bearer-token");
  });

  it("skips a fund the organization cannot trade — absent OR can_trade unstated", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { products: [{ exchange_code: WTGXX.exchangeCode }] } }
    );
    assert.deepEqual(await client.listStrategies(productionCtx), []);

    resetWisdomTreeTokenCache();
    mock.restoreAll();
    stubConnectFetch({ body: tokenReply }, { body: { products: [] } });
    assert.deepEqual(await client.listStrategies(productionCtx), []);
  });

  it("throws PROVIDER_UNAVAILABLE on a products response with no products array", async () => {
    stubConnectFetch({ body: tokenReply }, { body: {} });
    await assert.rejects(
      client.listStrategies(productionCtx),
      earnError("PROVIDER_UNAVAILABLE", /no products array/)
    );
  });

  it("classifies malformed product entries as PROVIDER_UNAVAILABLE", async () => {
    stubConnectFetch({ body: tokenReply }, { body: { products: [null] } });
    await assert.rejects(
      client.listStrategies(productionCtx),
      earnError("PROVIDER_UNAVAILABLE", /malformed product entry/)
    );
  });

  it("throws PROVIDER_UNAVAILABLE when the token endpoint returns no access_token", async () => {
    stubConnectFetch({ body: { token_type: "Bearer" } });
    await assert.rejects(
      client.listStrategies(productionCtx),
      earnError("PROVIDER_UNAVAILABLE", /no access_token/)
    );
  });

  it("surfaces the provider's own message on a refused token exchange", async () => {
    stubConnectFetch({ status: 401, body: { error: "invalid_grant" } });
    await assert.rejects(
      client.listStrategies(productionCtx),
      earnError("BAD_REQUEST", /invalid_grant/)
    );
  });

  it("caches the bearer token across calls in one environment", async () => {
    const fetchMock = stubConnectFetch(
      { body: tokenReply },
      { body: { products: [{ exchange_code: WTGXX.exchangeCode, can_trade: true }] } }
    );
    await client.listStrategies(productionCtx);
    await client.listStrategies(productionCtx);
    // 1 token call + 2 product reads: the second pass reuses the cached token.
    assert.equal(fetchMock.mock.callCount(), 3);
    assert.match(requestUrl(fetchMock, 2), /\/api\/orders\/products$/);
  });

  it("does not reuse a bearer token after any credential field rotates", async () => {
    const rotatedCtx: EarnRuntimeContext = {
      ...productionCtx,
      env: {
        WISDOMTREE_API_KEY: JSON.stringify({
          ...JSON.parse(credential),
          clientSecret: "rotated-client-secret",
        }),
      },
    };
    const fetchMock = stubConnectFetch(
      { body: { access_token: "first-token", expires_in: 600 } },
      { body: { products: [] } },
      { body: { access_token: "rotated-token", expires_in: 600 } },
      { body: { products: [] } }
    );

    await client.listStrategies(productionCtx);
    await client.listStrategies(rotatedCtx);

    assert.equal(fetchMock.mock.callCount(), 4);
    assert.match(requestUrl(fetchMock, 2), /\/o\/token\/$/);
  });

  it("refreshes a rejected bearer token and retries the request once", async () => {
    const fetchMock = stubConnectFetch(
      { body: { access_token: "stale-token", expires_in: 600 } },
      { status: 401, body: { error: "invalid_token" } },
      { body: { access_token: "fresh-token", expires_in: 600 } },
      { body: { products: [] } }
    );

    await client.listStrategies(productionCtx);

    assert.equal(fetchMock.mock.callCount(), 4);
    assert.equal(
      new Headers((fetchMock.mock.calls[3].arguments[1] as RequestInit).headers).get(
        "authorization"
      ),
      "Bearer fresh-token"
    );
  });
});

describe("checkDepositEligibility", () => {
  const owner = "OwnerWa11etAddre55555555555555555555555555555";

  const walletsReply = (records: unknown) => ({
    body: { data: { Solana: records } },
  });

  it("approves a registered, approved Solana wallet", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { guid: "org-guid" } },
      walletsReply([{ public_key: owner, status: "approved" }])
    );
    const verdict = await client.checkDepositEligibility(productionCtx, {
      providerReference: WTGXX.mint,
      owner,
    });
    assert.deepEqual(verdict, { eligible: true });
  });

  it("refuses an unregistered wallet with a customer-renderable reason", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { guid: "org-guid" } },
      walletsReply([{ public_key: "SomeOtherWallet", status: "approved" }])
    );
    const verdict = await client.checkDepositEligibility(productionCtx, {
      providerReference: WTGXX.mint,
      owner,
    });
    assert.equal(verdict.eligible, false);
    assert.match(verdict.reason ?? "", /not registered with WisdomTree Connect/);
  });

  it("fails closed on a registered wallet that is not approved", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { guid: "org-guid" } },
      walletsReply([{ public_key: owner, status: "pending" }])
    );
    const verdict = await client.checkDepositEligibility(productionCtx, {
      providerReference: WTGXX.mint,
      owner,
    });
    assert.equal(verdict.eligible, false);
    assert.match(verdict.reason ?? "", /status is "pending"/);
  });

  it("fails closed when the wallets response has no Solana lane", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { guid: "org-guid" } },
      { body: { data: { Ethereum: [{ public_key: owner, status: "approved" }] } } }
    );
    const verdict = await client.checkDepositEligibility(productionCtx, {
      providerReference: WTGXX.mint,
      owner,
    });
    assert.equal(verdict.eligible, false);
  });

  it("accepts the organisation_guid spelling and throws when every guid field is absent", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { organisation_guid: "org-guid" } },
      walletsReply([{ public_key: owner, status: "approved" }])
    );
    const verdict = await client.checkDepositEligibility(productionCtx, {
      providerReference: WTGXX.mint,
      owner,
    });
    assert.equal(verdict.eligible, true);

    resetWisdomTreeTokenCache();
    mock.restoreAll();
    stubConnectFetch({ body: tokenReply }, { body: { name: "Org with no guid" } });
    await assert.rejects(
      client.checkDepositEligibility(productionCtx, { providerReference: WTGXX.mint, owner }),
      earnError("PROVIDER_UNAVAILABLE", /no guid/)
    );
  });

  it("throws PROVIDER_UNAVAILABLE on a wallets response with no data map", async () => {
    stubConnectFetch({ body: tokenReply }, { body: { guid: "org-guid" } }, { body: {} });
    await assert.rejects(
      client.checkDepositEligibility(productionCtx, { providerReference: WTGXX.mint, owner }),
      earnError("PROVIDER_UNAVAILABLE", /no data map/)
    );
  });

  it("classifies malformed wallet entries as PROVIDER_UNAVAILABLE", async () => {
    stubConnectFetch(
      { body: tokenReply },
      { body: { guid: "org-guid" } },
      walletsReply([{ public_key: 42, status: "approved" }])
    );
    await assert.rejects(
      client.checkDepositEligibility(productionCtx, { providerReference: WTGXX.mint, owner }),
      earnError("PROVIDER_UNAVAILABLE", /invalid public_key/)
    );
  });
});
