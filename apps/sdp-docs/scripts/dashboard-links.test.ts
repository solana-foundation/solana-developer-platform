import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Link, Root } from "mdast";
import { remarkDashboardLinks } from "@/lib/dashboard-links";

const DEPLOYMENT_KEYS = ["NODE_ENV", "VERCEL_ENV", "NEXT_PUBLIC_SDP_WEB_URL"] as const;
const original = Object.fromEntries(DEPLOYMENT_KEYS.map((key) => [key, process.env[key]]));

/** Builds this deployment's environment: a production build paired with `webUrl`, or a preview. */
function deploy(target: { webUrl: string } | "unpaired preview") {
  for (const key of DEPLOYMENT_KEYS) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production" });
  if (target === "unpaired preview") {
    process.env.VERCEL_ENV = "preview";
  } else {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_SDP_WEB_URL = target.webUrl;
  }
}

afterEach(() => {
  for (const key of DEPLOYMENT_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else Object.assign(process.env, { [key]: value });
  }
});

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
  const paragraph = tree.children[0];
  if (paragraph?.type !== "paragraph") throw new Error("linkTree builds a paragraph");
  const link = paragraph.children[0];
  if (link?.type !== "link") throw new Error("linkTree builds a link");
  return link;
}

test("a beta build links its own dashboard and names its host", () => {
  deploy({ webUrl: "https://platform-beta.solana.com" });
  const transform = remarkDashboardLinks();

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
  deploy({ webUrl: "https://platform-beta.solana.com" });
  for (const url of [
    "https://platform.solana.com/docs/guides/go-to-mainnet",
    "https://platform.solana.com/dashboard",
    "https://explorer.solana.com",
    "/docs/reference/api",
  ]) {
    const tree = linkTree(url, "x");
    remarkDashboardLinks()(tree);
    assert.equal(linkOf(tree).url, url);
  }

  for (const target of [{ webUrl: "https://platform.solana.com" }, "unpaired preview"] as const) {
    deploy(target);
    const tree = linkTree("https://platform.solana.com", "platform.solana.com");
    remarkDashboardLinks()(tree);
    assert.equal(linkOf(tree).url, "https://platform.solana.com");
  }
});
