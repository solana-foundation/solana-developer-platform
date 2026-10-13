import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks } from "../src/lib/docs-blocks";
import { isPagePublished, type PublicSurface } from "../src/lib/release-channel";

const ALL: Pick<PublicSurface, "allModules" | "allRampProviders"> = {
  allModules: ["custody", "payments", "ramps", "issuance", "compliance", "earn"],
  allRampProviders: ["moonpay", "bvnk", "coinbase", "stripe"],
};

const STABLE: PublicSurface = {
  releaseChannel: "stable",
  modules: ["custody", "payments", "compliance"],
  rampProviders: [],
  allowedOperations: [{ family: "payment", types: ["payment_transfer_execute"] }],
  ...ALL,
};

const EXPERIMENTAL: PublicSurface = {
  releaseChannel: "experimental",
  modules: ["custody", "payments", "ramps", "issuance", "compliance"],
  rampProviders: ["bvnk", "stripe"],
  allowedOperations: [
    { family: "payment", types: ["payment_transfer_execute"] },
    { family: "ramp", types: ["ramp_onramp_quote"] },
  ],
  ...ALL,
};

const PAGE = [
  "---\r",
  "title: Shared\r",
  "---\r",
  "",
  "## Modules",
  "",
  "<ModuleTable />",
  "",
  "<RampProviderMatrix />",
  "",
  "<AllowedOperationsTable />",
  "",
  '```bash title="Terminal" rotate-providers',
  'curl -d \'{ "provider": "moonpay" }\'',
  "```",
  "After",
].join("\n");

function compiledText(source: string, surface: PublicSurface): string {
  const tree = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .parse(source.replace(/^---[\s\S]*?---\r?\n/, "")) as Root;
  remarkDocsBlocks({ surface })(tree, { path: "page.mdx" });
  return JSON.stringify(tree);
}

describe("docs follow the release channel", () => {
  it("publishes a page tagged with a module or ramp provider only when the build does", () => {
    assert.equal(isPagePublished({ module: "issuance" }, "p", STABLE), false);
    assert.equal(isPagePublished({ module: "issuance" }, "p", EXPERIMENTAL), true);
    assert.equal(isPagePublished({ rampProvider: "moonpay" }, "p", EXPERIMENTAL), false);
    assert.equal(isPagePublished({ rampProvider: "stripe" }, "p", EXPERIMENTAL), true);
    assert.equal(isPagePublished({}, "p", STABLE), true);
    assert.throws(
      () => isPagePublished({ module: "issuence" }, "p", STABLE),
      /module must be one of/
    );
  });

  it("renders generated blocks for what the build publishes, in text", () => {
    const stable = expandDocsBlocks(PAGE, "page.mdx", { surface: STABLE });
    assert.match(stable, /\| \*\*Payments\*\* \|/);
    assert.doesNotMatch(stable, /Issuance|Ramps|BVNK|Stripe|ramp_onramp_quote|ModuleTable/);
    assert.match(stable, /`payment_transfer_execute`/);

    const experimental = expandDocsBlocks(PAGE, "page.mdx", { surface: EXPERIMENTAL });
    assert.match(experimental, /\| \*\*Issuance\*\* \|/);
    assert.match(experimental, /\[BVNK\]\(\/docs\/payments\/ramps-bvnk\)/);
    assert.doesNotMatch(experimental, /MoonPay/);
    assert.match(experimental, /"provider": "bvnk"/);
    assert.match(experimental, /After$/);
  });

  it("renders the same blocks into the compiled page", () => {
    assert.doesNotMatch(compiledText(PAGE, STABLE), /Issuance|BVNK/);
    assert.match(compiledText(PAGE, EXPERIMENTAL), /Issuance/);
    assert.match(compiledText(PAGE, EXPERIMENTAL), /BVNK/);
  });

  it("leaves no sentence-level gates in the content", () => {
    const contentDir = path.resolve(import.meta.dirname, "../content/docs");
    const files = readdirSync(contentDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".mdx")
    );
    const gated = files.filter((file) =>
      /<(InChannel|ChannelRow)\b/.test(readFileSync(path.join(contentDir, file), "utf8"))
    );
    assert.deepEqual(gated, []);
  });
});
