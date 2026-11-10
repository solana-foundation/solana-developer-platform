import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Root } from "fumadocs-core/page-tree";
import { sectionByPath, sectionOverridesOf, topLevelUrlsOf } from "@/lib/sidebar-section";

const topLevelUrls = ["/docs", "/docs/payments", "/docs/reference", "/docs/reference/api"] as const;

describe("sidebar section by path", () => {
  it("picks the longest top-level URL the path extends", () => {
    assert.equal(
      sectionByPath(topLevelUrls, "/docs/reference/api/wallets/create-wallet"),
      "/docs/reference/api"
    );
    assert.equal(
      sectionByPath(topLevelUrls, "/docs/reference/conventions/errors"),
      "/docs/reference"
    );
  });

  it("never makes the home a section", () => {
    assert.equal(sectionByPath(topLevelUrls, "/docs/introduction"), undefined);
  });

  it("holds a path only under a whole segment", () => {
    assert.equal(sectionByPath(topLevelUrls, "/docs/payments-x"), undefined);
    assert.equal(
      sectionByPath(topLevelUrls, "/docs/payments/send-basic-payment"),
      "/docs/payments"
    );
  });
});

describe("sidebar top-level URLs", () => {
  it("lists pages and folders' own pages in order, skipping the rest", () => {
    const tree: Root = {
      name: "Docs",
      children: [
        { type: "page", name: "Get started", url: "/docs" },
        { type: "separator", name: "Modules" },
        { type: "page", name: "Payments", url: "/docs/payments" },
        {
          type: "folder",
          name: "API Reference",
          index: { type: "page", name: "API Reference", url: "/docs/reference/api" },
          children: [],
        },
        { type: "folder", name: "Unlinked", children: [] },
      ],
    };
    assert.deepEqual(topLevelUrlsOf(tree), ["/docs", "/docs/payments", "/docs/reference/api"]);
  });
});

describe("sidebar section overrides", () => {
  it("keeps only pages whose breadcrumb starts where their path does not", () => {
    const pages = [
      { url: "/docs/guides/setup-wallets", section: "/docs/wallet-operations" },
      { url: "/docs/payments/send-basic-payment", section: "/docs/payments" },
      { url: "/docs/introduction", section: undefined },
    ];
    assert.deepEqual(sectionOverridesOf(pages, [...topLevelUrls, "/docs/wallet-operations"]), {
      "/docs/guides/setup-wallets": "/docs/wallet-operations",
    });
  });
});
