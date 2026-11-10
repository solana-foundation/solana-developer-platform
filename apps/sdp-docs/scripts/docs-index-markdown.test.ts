import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Root } from "fumadocs-core/page-tree";
import { renderDocsIndexMarkdown } from "@/lib/docs-index-markdown";

const TREE: Root = {
  name: "Docs",
  children: [
    { type: "page", name: "What is SDP?", url: "/docs/introduction" },
    {
      type: "folder",
      name: "Payments",
      index: { type: "page", name: "Overview", url: "/docs/payments" },
      children: [
        { type: "separator", name: "Send Payments" },
        { type: "page", name: "Basic payment", url: "/docs/payments/send-basic-payment" },
      ],
    },
    {
      type: "folder",
      name: "Reference",
      children: [
        {
          type: "folder",
          name: "API",
          children: [{ type: "page", name: "Wallets", url: "/docs/reference/api/wallets" }],
        },
      ],
    },
  ],
};

const DESCRIPTIONS = new Map([
  ["/docs/introduction", "One API in front of\ninterchangeable providers."],
]);

describe("docs index Markdown", () => {
  it("lists every nav page under its folder and separator headings", () => {
    const markdown = renderDocsIndexMarkdown(
      { title: "Ship anything onchain\nwith SDP", description: "A dashboard and REST API." },
      TREE,
      (url) => DESCRIPTIONS.get(url)
    );

    assert.equal(
      markdown,
      [
        "# Ship anything onchain with SDP",
        "",
        "A dashboard and REST API.",
        "",
        "- [What is SDP?](/docs/introduction): One API in front of interchangeable providers.",
        "",
        "## Payments",
        "",
        "- [Overview](/docs/payments)",
        "",
        "### Send Payments",
        "",
        "- [Basic payment](/docs/payments/send-basic-payment)",
        "",
        "## Reference",
        "",
        "### API",
        "",
        "- [Wallets](/docs/reference/api/wallets)",
        "",
      ].join("\n")
    );
  });
});
