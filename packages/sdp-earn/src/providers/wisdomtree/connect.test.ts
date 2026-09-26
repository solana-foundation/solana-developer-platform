import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SdpEarnError } from "../../errors";
import type { EarnRuntimeContext } from "../../types";
import {
  readWisdomTreePurchaseOrderCompletion,
  resetWisdomTreeOrdersFeedCache,
  resetWisdomTreeTokenCache,
} from "./connect";

/**
 * The completion correlation's no-network harness, same rule as client.test.ts:
 * `globalThis.fetch` is stubbed per test and restored in `afterEach` — no test
 * may ever reach the real WisdomTree Connect API.
 */

const credential = JSON.stringify({
  clientId: "client-id",
  clientSecret: "client-secret",
  username: "api-user",
  password: "api-pass",
});

const ctx: EarnRuntimeContext = {
  env: { WISDOMTREE_API_KEY: credential },
  environment: "production",
};

const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const FUND = "WTGXX";
const AMOUNT = "250.50";
/** The deposit's own record instant: fixtures complete at or after it. */
const MOVEMENT_CREATED_AT = "2026-09-25T00:00:00Z";

const input = {
  owner: OWNER,
  fundExchangeCode: FUND,
  amountRequested: AMOUNT,
  movementCreatedAt: MOVEMENT_CREATED_AT,
  excludedOrderReferences: [] as readonly string[],
};

const tokenReply = { access_token: "bearer-token", expires_in: 600 };

/** Stub the token exchange, then serve `orders` as the orders feed. */
function stubOrdersFeed(orders: unknown) {
  return mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/o/token/")) {
      return new Response(JSON.stringify(tokenReply), { status: 200 });
    }
    return new Response(JSON.stringify({ orders }), { status: 200 });
  });
}

beforeEach(() => {
  resetWisdomTreeTokenCache();
  resetWisdomTreeOrdersFeedCache();
});
afterEach(() => mock.restoreAll());

describe("readWisdomTreePurchaseOrderCompletion", () => {
  it("answers the completed matching order", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.deepEqual(await readWisdomTreePurchaseOrderCompletion(ctx, input), {
      orderReference: "order-7",
      completedAt: "2026-09-25T10:00:00Z",
    });
  });

  it("matches the same amount across decimal spellings", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: "250.5000",
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.deepEqual(await readWisdomTreePurchaseOrderCompletion(ctx, input), {
      orderReference: "order-7",
      completedAt: "2026-09-25T10:00:00Z",
    });
  });

  it("is case-insensitive on status, wallet and fund spellings", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "Completed",
        wallet_address: OWNER.toLowerCase(),
        fund: FUND.toLowerCase(),
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    const completion = await readWisdomTreePurchaseOrderCompletion(ctx, input);
    assert.equal(completion?.orderReference, "order-7");
  });

  it("keeps looking past orders that do not match", async () => {
    stubOrdersFeed([
      // A completed Sale for this wallet: never a deposit's completion.
      {
        trade_type: "Sale",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
      },
      // A pending Purchase with the same keys: the order is still working.
      {
        id: "order-8",
        trade_type: "Purchase",
        status: "pending",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
      },
      // A completed Purchase for a different wallet: someone else's order.
      {
        id: "order-9",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: "DifferentWallet111111111111111111111111111",
        fund: FUND,
        amount: AMOUNT,
      },
      // A completed Purchase for a different fund and amount.
      {
        id: "order-10",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: "OTHER",
        amount: "1.00",
      },
      // The one that matches.
      {
        id: "order-11",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: "250.50",
        completed_at: "2026-09-26T10:00:00Z",
      },
    ]);
    assert.deepEqual(await readWisdomTreePurchaseOrderCompletion(ctx, input), {
      orderReference: "order-11",
      completedAt: "2026-09-26T10:00:00Z",
    });
  });

  it("answers null when no order demonstrates completion", async () => {
    stubOrdersFeed([]);
    assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
  });

  it("answers null when the matching order carries no amount", async () => {
    // An order missing its amount cannot be correlated: the deposit amount is
    // the difference between this customer's order and anyone else's.
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
      },
    ]);
    assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
  });

  it("answers null when the matching order names a non-decimal amount", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: "not-a-number",
      },
    ]);
    assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
  });

  it("does not settle this deposit from an older purchase of the same wallet, fund, and amount", async () => {
    // The exact false-settle: an order that completed BEFORE the deposit was
    // recorded matches every other key. Settling the deposit from it would
    // release the cross-key claim while this deposit's own order is still
    // pending and let a twin double-broadcast.
    stubOrdersFeed([
      {
        id: "order-2",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-20T10:00:00Z",
      },
    ]);
    assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
  });

  it("skips an older purchase and answers the deposit's own later order", async () => {
    stubOrdersFeed([
      {
        id: "order-2",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-20T10:00:00Z",
      },
      {
        id: "order-9",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.deepEqual(await readWisdomTreePurchaseOrderCompletion(ctx, input), {
      orderReference: "order-9",
      completedAt: "2026-09-25T10:00:00Z",
    });
  });

  it("correlates an order completed within the clock-skew tolerance", async () => {
    // A provider clock lagging SDP's by moments must not strand a genuine
    // completion: one minute behind is tolerated; last week is not.
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-24T23:59:00Z",
      },
    ]);
    assert.equal(
      (await readWisdomTreePurchaseOrderCompletion(ctx, input))?.orderReference,
      "order-7"
    );
  });

  it("cannot bind an order with no readable completion time to this deposit", async () => {
    // Without a completion instant there is no fact that separates this
    // deposit's order from an older twin purchase, so the match is ambiguous
    // and the row stays open.
    for (const completed_at of [null, "not-a-date"]) {
      stubOrdersFeed([
        {
          id: "order-7",
          trade_type: "Purchase",
          status: "completed",
          wallet_address: OWNER,
          fund: FUND,
          amount: AMOUNT,
          completed_at,
        },
      ]);
      assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
    }
  });

  it("answers null when the deposit's own record instant is unreadable", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.equal(
      await readWisdomTreePurchaseOrderCompletion(ctx, {
        ...input,
        movementCreatedAt: "not-a-date",
      }),
      null
    );
  });

  it("cannot bind an order with no readable identity to this deposit", async () => {
    // An order that cannot name itself is indistinguishable from an older
    // twin purchase's completion: settling this deposit from it would release
    // the cross-key claim while this deposit's own order is still pending.
    stubOrdersFeed([
      {
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.equal(await readWisdomTreePurchaseOrderCompletion(ctx, input), null);
  });

  it("skips an order the ledger already accepted for another deposit", async () => {
    // One order completes at most one movement: the identity the ledger has
    // already stamped settled a DIFFERENT deposit, so this read keeps looking
    // for this deposit's own order.
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
      {
        id: "order-9",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T11:00:00Z",
      },
    ]);
    assert.deepEqual(
      await readWisdomTreePurchaseOrderCompletion(ctx, {
        ...input,
        excludedOrderReferences: ["order-7"],
      }),
      { orderReference: "order-9", completedAt: "2026-09-25T11:00:00Z" }
    );
  });

  it("stays open when the only completed match was already consumed by another deposit", async () => {
    stubOrdersFeed([
      {
        id: "order-7",
        trade_type: "Purchase",
        status: "completed",
        wallet_address: OWNER,
        fund: FUND,
        amount: AMOUNT,
        completed_at: "2026-09-25T10:00:00Z",
      },
    ]);
    assert.equal(
      await readWisdomTreePurchaseOrderCompletion(ctx, {
        ...input,
        excludedOrderReferences: ["order-7"],
      }),
      null
    );
  });

  it("throws PROVIDER_UNAVAILABLE on a malformed order entry", async () => {
    stubOrdersFeed([{ status: 7 }]);
    await assert.rejects(
      readWisdomTreePurchaseOrderCompletion(ctx, input),
      (error: unknown) => error instanceof SdpEarnError
    );
  });

  it("throws PROVIDER_UNAVAILABLE when the feed answers in an unrecognized shape", async () => {
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/o/token/")) {
        return new Response(JSON.stringify(tokenReply), { status: 200 });
      }
      return new Response(JSON.stringify({ nope: true }), { status: 200 });
    });
    await assert.rejects(
      readWisdomTreePurchaseOrderCompletion(ctx, input),
      (error: unknown) => error instanceof SdpEarnError
    );
  });

  it("serves a refusal walk's repeated reads from one orders fetch", async () => {
    // The completion walk re-reads with a grown exclusion set after every
    // refused stamp (see the provider-order completion service). Each re-read
    // must come from the cached snapshot, not a fresh full-feed request — one
    // deposit's settlement can otherwise cost the provider its feed once per
    // refused order, per movement, per pass.
    let feedRequests = 0;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/o/token/")) {
        return new Response(JSON.stringify(tokenReply), { status: 200 });
      }
      feedRequests += 1;
      return new Response(
        JSON.stringify({
          orders: [
            {
              id: "order-7",
              trade_type: "Purchase",
              status: "completed",
              wallet_address: OWNER,
              fund: FUND,
              amount: AMOUNT,
              completed_at: "2026-09-25T10:00:00Z",
            },
            {
              id: "order-9",
              trade_type: "Purchase",
              status: "completed",
              wallet_address: OWNER,
              fund: FUND,
              amount: AMOUNT,
              completed_at: "2026-09-25T11:00:00Z",
            },
          ],
        }),
        { status: 200 }
      );
    });
    assert.deepEqual(await readWisdomTreePurchaseOrderCompletion(ctx, input), {
      orderReference: "order-7",
      completedAt: "2026-09-25T10:00:00Z",
    });
    assert.deepEqual(
      await readWisdomTreePurchaseOrderCompletion(ctx, {
        ...input,
        excludedOrderReferences: ["order-7"],
      }),
      { orderReference: "order-9", completedAt: "2026-09-25T11:00:00Z" }
    );
    assert.equal(
      await readWisdomTreePurchaseOrderCompletion(ctx, {
        ...input,
        excludedOrderReferences: ["order-7", "order-9"],
      }),
      null
    );
    assert.equal(feedRequests, 1);
  });
});
