import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SortedResult } from "fumadocs-core/search";
import { rankTitlesFirst } from "@/lib/search-rank";

function page(url: string, title: string): SortedResult {
  return { id: url, type: "page", url, content: title };
}

function passage(url: string, content: string): SortedResult {
  return { id: `${url}-passage`, type: "text", url, content };
}

const descriptions: Record<string, string> = {
  "/docs/tutorial": "Issue a token end to end.",
  "/docs/keys": "Create, rotate and revoke keys.",
  "/docs/payment": "Send a single token transfer.",
  "/docs/payouts": "Pay many recipients at once.",
};

describe("search ranking", () => {
  it("puts the page titled with every query word first, its passages under it", () => {
    const results = [
      page("/docs/tutorial", "Issue a stablecoin"),
      passage("/docs/tutorial", "Create an API key first."),
      page("/docs/keys", "Manage API keys"),
      passage("/docs/keys", "Each API key holds grants."),
    ];
    assert.deepEqual(
      rankTitlesFirst(results, "api key", (url) => descriptions[url]).map((result) => result.id),
      ["/docs/keys", "/docs/keys-passage", "/docs/tutorial", "/docs/tutorial-passage"]
    );
  });

  it("ranks a title and description that hold the query above a title holding part of it", () => {
    const results = [page("/docs/payouts", "Payouts"), page("/docs/payment", "Basic payment")];
    assert.deepEqual(
      rankTitlesFirst(results, "send payment", (url) => descriptions[url]).map(
        (result) => result.id
      ),
      ["/docs/payment", "/docs/payouts"]
    );
  });

  it("keeps the engine's order between pages of one rank", () => {
    const results = [
      page("/docs/payouts", "Payouts"),
      page("/docs/tutorial", "Issue a stablecoin"),
    ];
    assert.deepEqual(
      rankTitlesFirst(results, "webhook", (url) => descriptions[url]).map((result) => result.id),
      ["/docs/payouts", "/docs/tutorial"]
    );
  });
});
