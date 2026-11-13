import assert from "node:assert/strict";
import { test } from "node:test";
import type { Link, Paragraph, Root } from "mdast";
import { remarkDashboardLinks } from "@/lib/dashboard-links";

function linkTree(url: string, text: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "link", url, children: [{ type: "text", value: text }] }],
      },
    ],
  };
}

function linkOf(tree: Root): Link {
  const paragraph = tree.children[0] as Paragraph;
  return paragraph.children[0] as Link;
}

test("a beta build links its own dashboard and names its host", () => {
  const transform = remarkDashboardLinks({ dashboardUrl: "https://platform-beta.solana.com/" });

  const signUp = linkTree("https://platform.solana.com", "platform.solana.com");
  transform(signUp);
  assert.equal(linkOf(signUp).url, "https://platform-beta.solana.com/");
  assert.deepEqual(linkOf(signUp).children, [{ type: "text", value: "platform-beta.solana.com" }]);

  const signIn = linkTree("https://platform.solana.com/sign-in?redirect_url=x", "sign in");
  transform(signIn);
  assert.equal(linkOf(signIn).url, "https://platform-beta.solana.com/sign-in?redirect_url=x");
  assert.deepEqual(linkOf(signIn).children, [{ type: "text", value: "sign in" }]);
});

test("docs and dashboard pages, other sites and the production build keep their links", () => {
  const beta = remarkDashboardLinks({ dashboardUrl: "https://platform-beta.solana.com/" });
  for (const url of [
    "https://platform.solana.com/docs/guides/go-to-mainnet",
    "https://platform.solana.com/dashboard",
    "https://explorer.solana.com",
    "/docs/reference/api",
  ]) {
    const tree = linkTree(url, "x");
    beta(tree);
    assert.equal(linkOf(tree).url, url);
  }

  for (const dashboardUrl of ["https://platform.solana.com/", null]) {
    const tree = linkTree("https://platform.solana.com", "platform.solana.com");
    remarkDashboardLinks({ dashboardUrl })(tree);
    assert.equal(linkOf(tree).url, "https://platform.solana.com");
  }
});
