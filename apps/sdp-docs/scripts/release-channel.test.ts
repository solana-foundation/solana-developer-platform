import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkChannelGates, resolveChannelGates } from "../src/lib/channel-gates";
import type { PublicSurface } from "../src/lib/release-channel";

const ALL_MODULES = ["custody", "payments", "ramps", "issuance", "earn", "dvp", "markets"];
const ALL_PROVIDERS = ["moonpay", "stripe"];

const STABLE: PublicSurface = {
  releaseChannel: "stable",
  modules: ["custody", "payments"],
  rampProviders: [],
  allModules: ALL_MODULES,
  allRampProviders: ALL_PROVIDERS,
};

const EXPERIMENTAL: PublicSurface = {
  releaseChannel: "experimental",
  modules: ["custody", "payments", "ramps", "issuance", "dvp", "markets"],
  rampProviders: ["stripe"],
  allModules: ALL_MODULES,
  allRampProviders: ALL_PROVIDERS,
};

const PAGE = [
  "---\r",
  "title: Shared\r",
  "---\r",
  "",
  'Transfers<InChannel module="ramps"> and ramps</InChannel>.',
  "",
  '<InChannel module="issuance">',
  "",
  "### Issuance heading",
  "",
  "- [Mint and Burn](/docs/tokens/mint-and-burn)",
  "",
  "</InChannel>",
  "",
  "| Module | What |",
  "| --- | --- |",
  '| **Issuance** <ChannelRow module="issuance" /> | Mint tokens |',
  "| **Payments** | Move funds |",
  "",
  '<InChannel rampProvider="moonpay">MoonPay only.</InChannel>',
  '<InChannel rampProvider="stripe">Stripe only.</InChannel>',
  "After",
].join("\n");

const headingsAfterPlugin = (source: string, surface: PublicSurface): string[] => {
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
  const tree = processor.parse(source.replace(/^---[\s\S]*?---\r?\n/, "")) as Root;
  remarkChannelGates({ surface })(tree, { path: "page.mdx" });
  const texts: string[] = [];
  const visit = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === "text" && node.value) texts.push(node.value);
    for (const child of (node.children ?? []) as (typeof node)[]) visit(child);
  };
  visit(tree);
  return texts;
};

describe("release-channel gates", () => {
  it("drops out-of-channel passages, rows and providers from raw MDX", () => {
    const stable = resolveChannelGates(PAGE, "page.mdx", { surface: STABLE });
    assert.doesNotMatch(stable, /ramps|Issuance|mint-and-burn|MoonPay|Stripe|InChannel|ChannelRow/);
    assert.match(stable, /Transfers\./);
    assert.match(stable, /\| \*\*Payments\*\* \| Move funds \|/);
    assert.match(stable, /After$/);
  });

  it("unwraps in-channel gates without leaving their tags", () => {
    const experimental = resolveChannelGates(PAGE, "page.mdx", { surface: EXPERIMENTAL });
    assert.match(experimental, /Transfers and ramps\./);
    assert.match(experimental, /### Issuance heading/);
    assert.match(experimental, /\| \*\*Issuance\*\* \| Mint tokens \|/);
    assert.match(experimental, /Stripe only\./);
    assert.doesNotMatch(experimental, /MoonPay|InChannel|ChannelRow/);
  });

  it("keeps line numbers when asked, for the link checker", () => {
    const stable = resolveChannelGates(PAGE, "page.mdx", { surface: STABLE, preserveLines: true });
    assert.equal(stable.split("\n").length, PAGE.split("\n").length);
  });

  it("removes hidden headings from the compiled tree, so the TOC never lists them", () => {
    assert.ok(!headingsAfterPlugin(PAGE, STABLE).includes("Issuance heading"));
    assert.ok(headingsAfterPlugin(PAGE, EXPERIMENTAL).includes("Issuance heading"));
  });

  it("rejects unknown modules, expression attributes and stray row markers", () => {
    assert.throws(
      () =>
        resolveChannelGates('<InChannel module="issuence">x</InChannel>', "p", { surface: STABLE }),
      /module must be one of/
    );
    assert.throws(
      () =>
        resolveChannelGates('<InChannel module={"ramps"}>x</InChannel>', "p", { surface: STABLE }),
      /one literal module or rampProvider/
    );
    assert.throws(
      () => resolveChannelGates('Text <ChannelRow module="ramps" />', "p", { surface: STABLE }),
      /belongs in a table row/
    );
  });
});
