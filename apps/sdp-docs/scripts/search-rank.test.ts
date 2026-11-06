import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SortedResult } from "fumadocs-core/search";
import { rankTitlesFirst } from "@/lib/search-rank";

const descriptions = {
  "/docs/tutorial": "Issue a token end to end.",
  "/docs/keys": "Create, rotate and revoke keys.",
  "/docs/payment": "Send a single token transfer.",
  "/docs/payouts": "Pay many recipients at once.",
  "/docs/earn": "Earn yield on stablecoins.",
  "/docs/earn/concepts": "Understand strategies, shares, value, and withdrawals.",
  "/docs/earn/withdrawals": "Choose an exit and track funds back to the owner's wallet.",
  "/docs/reference/api/earn": "Earn API operations.",
  "/docs/reference/api/earn/get-earn-external-wallet-earnings": "Read balance and earned yield.",
  "/docs/reference/api/earn/create-earn-vault-withdrawal": "Submit a custody withdrawal.",
} as const satisfies Record<string, string>;

type FixtureUrl = keyof typeof descriptions;

function isFixtureUrl(url: string): url is FixtureUrl {
  return Object.hasOwn(descriptions, url);
}

/** A fixture page's description, as the route reads one from the source. */
function descriptionOf(url: string): string | undefined {
  return isFixtureUrl(url) ? descriptions[url] : undefined;
}

function page(url: FixtureUrl, title: string): SortedResult {
  return { id: url, type: "page", url, content: title };
}

function passage(url: FixtureUrl, content: string): SortedResult {
  return { id: `${url}-passage`, type: "text", url, content };
}

describe("search ranking", () => {
  it("puts the page titled with every query word first, its passages under it", () => {
    const results = [
      page("/docs/tutorial", "Issue a stablecoin"),
      passage("/docs/tutorial", "Create an API key first."),
      page("/docs/keys", "Manage API keys"),
      passage("/docs/keys", "Each API key holds grants."),
    ];
    assert.deepEqual(
      rankTitlesFirst(results, "api key", descriptionOf).map((result) => result.id),
      ["/docs/keys", "/docs/keys-passage", "/docs/tutorial", "/docs/tutorial-passage"]
    );
  });

  it("ranks a title and description that hold the query above a title holding part of it", () => {
    const results = [page("/docs/payouts", "Payouts"), page("/docs/payment", "Basic payment")];
    assert.deepEqual(
      rankTitlesFirst(results, "send payment", descriptionOf).map((result) => result.id),
      ["/docs/payment", "/docs/payouts"]
    );
  });

  it("keeps the engine's order between pages of one rank", () => {
    const results = [
      page("/docs/payouts", "Payouts"),
      page("/docs/tutorial", "Issue a stablecoin"),
    ];
    assert.deepEqual(
      rankTitlesFirst(results, "webhook", descriptionOf).map((result) => result.id),
      ["/docs/payouts", "/docs/tutorial"]
    );
  });

  it("puts the Earn overview before an earnings prefix and the family reference", () => {
    const results = [
      page("/docs/reference/api/earn/get-earn-external-wallet-earnings", "Get wallet earnings"),
      page("/docs/reference/api/earn", "Earn"),
      page("/docs/earn", "Earn"),
    ];
    assert.equal(rankTitlesFirst(results, "earn", descriptionOf)[0]?.url, "/docs/earn");
  });

  it("finds the withdrawal guide for withdrawal and withdrawal inflections", () => {
    const results = [
      page(
        "/docs/reference/api/earn/create-earn-vault-withdrawal",
        "Withdraw from a custody position"
      ),
      page("/docs/earn/withdrawals", "Withdraw funds"),
    ];
    for (const query of ["withdraw", "withdrawal", "withdrawals"]) {
      assert.equal(
        rankTitlesFirst(results, query, descriptionOf)[0]?.url,
        "/docs/earn/withdrawals"
      );
    }
  });

  it("puts an exact endpoint owner before guides that mention its path", () => {
    const endpointUrl = "/docs/reference/api/earn/create-earn-vault-withdrawal";
    const results = [
      page("/docs/earn/withdrawals", "Withdraw funds"),
      passage("/docs/earn/withdrawals", "Submit through POST /v1/earn/vault-withdrawals."),
      page(endpointUrl, "Withdraw from a custody position"),
      passage(endpointUrl, "POST /v1/earn/vault-withdrawals"),
    ];
    for (const query of [
      "/v1/earn/vault-withdrawals",
      "POST /v1/earn/vault-withdrawals",
      "create-earn-vault-withdrawal",
      endpointUrl,
    ]) {
      const ranked = rankTitlesFirst(results, query, descriptionOf);
      assert.equal(ranked[0]?.url, endpointUrl);
      assert.equal(ranked[1]?.content, "POST /v1/earn/vault-withdrawals");
    }
  });

  it("puts the guide's matching heading before a passing body mention", () => {
    const results: SortedResult[] = [
      page("/docs/tutorial", "Issue a stablecoin"),
      passage("/docs/tutorial", "A token might be used by a DeFi strategy."),
      page("/docs/earn/concepts", "How Earn works"),
      {
        id: "defi-heading",
        type: "heading",
        url: "/docs/earn/concepts#defi-and-real-world-assets",
        content: "DeFi and real-world assets",
      },
    ];
    assert.equal(rankTitlesFirst(results, "defi", descriptionOf)[0]?.url, "/docs/earn/concepts");
    assert.equal(rankTitlesFirst(results, "defi", descriptionOf)[1]?.id, "defi-heading");
  });

  it("refuses a passage listed before any page", () => {
    const results = [passage("/docs/keys", "Each API key holds grants.")];
    assert.throws(
      () => rankTitlesFirst(results, "api key", descriptionOf),
      /Search passage came before its page/
    );
  });
});
