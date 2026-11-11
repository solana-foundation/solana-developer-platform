import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isCustodyProviderPublished, SDP_RELEASE_CHANNELS } from "@sdp/types/release-channels";
import { structure } from "fumadocs-core/mdx-plugins/remark-structure";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks } from "@/lib/docs-blocks";
import {
  isPagePublished,
  isPageSourcePublished,
  type PublicSurface,
  pageGateOf,
  parsePageGateFields,
} from "@/lib/release-channel";

const ALL: Pick<PublicSurface, "allModules" | "allRampProviders" | "rateLimits"> = {
  allModules: ["custody", "payments", "ramps", "issuance", "compliance", "earn"],
  allRampProviders: ["moonpay", "stripe"],
  rateLimits: {
    windowSeconds: 60,
    apiKeyTiers: { standard: 100, elevated: 500, unlimited: 10_000 },
    unauthenticatedPerIp: 20,
  },
};

const STABLE: PublicSurface = {
  releaseChannel: "stable",
  modules: ["custody", "payments", "compliance"],
  rampProviders: [],
  custodyProviders: ["privy"],
  walletCreateDedupe: [
    { provider: "privy", mode: "managed", window: "permanent" },
    { provider: "privy", mode: "byok", window: "permanent" },
  ],
  grantableActions: [{ module: "transfers", verbs: ["read", "execute"] }],
  ...ALL,
};

const EXPERIMENTAL: PublicSurface = {
  releaseChannel: "experimental",
  modules: ["custody", "payments", "ramps", "issuance", "compliance"],
  rampProviders: ["stripe"],
  custodyProviders: ["fireblocks", "privy", "turnkey"],
  walletCreateDedupe: [
    { provider: "fireblocks", mode: "byok", window: "24h" },
    { provider: "privy", mode: "managed", window: "permanent" },
    { provider: "privy", mode: "byok", window: "permanent" },
  ],
  grantableActions: [
    { module: "transfers", verbs: ["read", "execute"] },
    { module: "onramp", verbs: ["read", "execute"] },
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
  "<ApiKeyGrantsTable />",
  "",
  '```bash title="Terminal" rotate-providers',
  'curl -d \'{ "provider": "moonpay" }\'',
  "```",
  "After",
].join("\n");

const bodyOf = (source: string) => source.replace(/^---[\s\S]*?---\r?\n/, "");

function compiledText(source: string, surface: PublicSurface): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .use(remarkDocsBlocks, { surface });
  return JSON.stringify(processor.runSync(processor.parse(bodyOf(source))));
}

function searchText(source: string, surface: PublicSurface): string {
  const search = structure(bodyOf(source), [remarkMdx, [remarkDocsBlocks, { surface }]]);
  return search.contents.map(({ content }) => content).join("\n");
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

  it("publishes custody provider pages from the API manifest in every channel", () => {
    const source =
      "---\ntitle: Connect Fireblocks\ncustodyProvider: fireblocks\n---\nSetup steps.\n";
    const fields = parsePageGateFields(
      { title: "Connect Fireblocks", custodyProvider: "fireblocks" },
      "wallet-operations/fireblocks.mdx"
    );
    assert.deepEqual(pageGateOf(fields, "wallet-operations/fireblocks.mdx"), {
      custodyProvider: "fireblocks",
    });

    for (const releaseChannel of ["stable", "beta", "experimental"] as const) {
      const published = isCustodyProviderPublished(releaseChannel, "fireblocks");
      const surface: PublicSurface = {
        ...STABLE,
        releaseChannel,
        custodyProviders: published ? ["privy", "fireblocks"] : ["privy"],
      };
      assert.equal(isPagePublished(fields, "fireblocks.mdx", surface), published);
      assert.equal(isPageSourcePublished(source, "fireblocks.mdx", surface), published);
    }

    // A provider promotion needs only a new API manifest, with no docs gate edit.
    assert.equal(
      isPageSourcePublished(source, "fireblocks.mdx", {
        ...STABLE,
        custodyProviders: ["privy", "fireblocks"],
      }),
      true
    );
  });

  it("rejects unknown custody providers and conflicting page gates before publication", () => {
    assert.throws(
      () =>
        isPageSourcePublished(
          "---\ncustodyProvider: fireblokcs\n---\nHidden page.\n",
          "fireblocks.mdx",
          STABLE
        ),
      /custodyProvider must be one of/
    );
    for (const otherGate of [{ module: "custody" }, { rampProvider: "stripe" }]) {
      assert.throws(
        () => parsePageGateFields({ custodyProvider: "fireblocks", ...otherGate }, "p"),
        /only one of module, rampProvider or custodyProvider/
      );
    }
    assert.throws(
      () => parsePageGateFields({ custodyProvider: ["fireblocks"] }, "p"),
      /invalid frontmatter/
    );
  });

  it("publishes Earn pages and shared listings through the ordinary module gate", () => {
    for (const [releaseChannel, published] of [
      ["stable", false],
      ["beta", true],
      ["experimental", true],
    ] as const) {
      const surface: PublicSurface = {
        ...EXPERIMENTAL,
        releaseChannel,
        modules: SDP_RELEASE_CHANNELS[releaseChannel],
      };
      assert.equal(isPagePublished({ module: "earn" }, "earn/index.mdx", surface), published);
      const modules = expandDocsBlocks("<ModuleTable />\n", "introduction.mdx", { surface });
      assert.equal(modules.includes("**Earn**"), published);
    }
  });

  it("renders generated blocks for what the build publishes, in text", () => {
    const stable = expandDocsBlocks(PAGE, "page.mdx", { surface: STABLE });
    assert.match(stable, /\| \*\*Payments\*\* \|/);
    assert.doesNotMatch(stable, /Issuance|Ramps|Stripe|onramp\.execute|ModuleTable/);
    assert.match(stable, /`transfers\.execute`/);

    const experimental = expandDocsBlocks(PAGE, "page.mdx", { surface: EXPERIMENTAL });
    assert.match(experimental, /\| \*\*Issuance\*\* \|/);
    assert.match(experimental, /\[Stripe\]\(\/docs\/payments\/ramps-stripe\)/);
    assert.doesNotMatch(experimental, /MoonPay/);
    assert.match(experimental, /"provider": "stripe"/);
    assert.match(experimental, /After$/);
  });

  it("keeps the tutorial landing page within the published modules", () => {
    const page = readFileSync(
      path.resolve(import.meta.dirname, "../content/docs/tutorials/index.mdx"),
      "utf8"
    );
    const stable = expandDocsBlocks(page, "tutorials/index.mdx", { surface: STABLE });
    const experimental = expandDocsBlocks(page, "tutorials/index.mdx", {
      surface: EXPERIMENTAL,
    });

    assert.match(stable, /end-to-end-payment-flow/);
    assert.doesNotMatch(stable, /issue-a-regulated-stablecoin|TutorialLinks/);
    assert.match(experimental, /issue-a-regulated-stablecoin/);
  });

  it("tables only the custody providers the build publishes", () => {
    const stable = expandDocsBlocks("<CustodyProviderTable />\n", "wallets.mdx", {
      surface: STABLE,
    });
    assert.match(stable, /\| \*\*Privy\*\* \|/);
    assert.doesNotMatch(stable, /Fireblocks|Turnkey|Local/);

    const experimental = expandDocsBlocks("<CustodyProviderTable />\n", "wallets.mdx", {
      surface: EXPERIMENTAL,
    });
    assert.match(
      experimental,
      /\| \*\*\[Fireblocks\]\(\/docs\/wallet-operations\/fireblocks\)\*\* \|/
    );
    assert.match(experimental, /\| \*\*Turnkey\*\* \|/);
    assert.doesNotMatch(experimental, /Anchorage/);
  });

  it("keeps custody setup links consistent in Markdown, compiled pages and search", () => {
    const source = "<CustodyProviderGuides />\n";
    const beta: PublicSurface = { ...EXPERIMENTAL, releaseChannel: "beta" };
    for (const surface of [STABLE, beta, EXPERIMENTAL]) {
      const published = surface.custodyProviders.includes("fireblocks");
      const markdown = expandDocsBlocks(source, "wallets.mdx", { surface });
      const compiled = compiledText(source, surface);
      const search = searchText(source, surface);
      assert.equal(markdown.includes("/docs/wallet-operations/fireblocks"), published);
      assert.equal(compiled.includes("/docs/wallet-operations/fireblocks"), published);
      assert.equal(search.includes("Connect Fireblocks"), published);
      assert.doesNotMatch(markdown, /CustodyProviderGuides/);
      if (published) assert.match(markdown, /your own Fireblocks workspace for production custody/);
    }
    assert.match(
      expandDocsBlocks(source, "wallets.mdx", {
        surface: { ...STABLE, custodyProviders: ["privy", "fireblocks"] },
      }),
      /\[Connect Fireblocks\]\(\/docs\/wallet-operations\/fireblocks\)/
    );
  });

  it("tables the wallet creates a same-key retry reruns, with each window", () => {
    const stable = expandDocsBlocks("<WalletCreateRetryTable />\n", "idempotency.mdx", {
      surface: STABLE,
    });
    assert.match(stable, /\| \*\*Privy\*\* \| Managed \(`provider`\) \| Always \|/);
    assert.doesNotMatch(stable, /Fireblocks|Coinbase/);

    const experimental = expandDocsBlocks("<WalletCreateRetryTable />\n", "idempotency.mdx", {
      surface: EXPERIMENTAL,
    });
    assert.match(
      experimental,
      /\| \*\*Fireblocks\*\* \| Custody Connection \(`connectionId`\) \| Within 24 hours of the first attempt \|/
    );
  });

  it("tables the API's rate limits from the manifest", () => {
    const limits = expandDocsBlocks("<RateLimitTable />\n", "rate-limits.mdx", { surface: STABLE });
    assert.equal(
      limits,
      [
        "| Caller | Requests per minute |",
        "| --- | --- |",
        "| An API key on the `standard` tier | 100 |",
        "| An API key on the `elevated` tier | 500 |",
        "| An API key on the `unlimited` tier | 10,000 |",
        "| No API key, per IP address | 20 |",
        "",
      ].join("\n")
    );
  });

  it("renders the same blocks into the compiled page", () => {
    assert.doesNotMatch(compiledText(PAGE, STABLE), /Issuance|Stripe/);
    assert.match(compiledText(PAGE, EXPERIMENTAL), /Issuance/);
    assert.match(compiledText(PAGE, EXPERIMENTAL), /Stripe/);
  });

  it("indexes the blocks' rows for search", () => {
    assert.match(searchText(PAGE, EXPERIMENTAL), /\*\*Issuance\*\*/);
    assert.match(searchText(PAGE, EXPERIMENTAL), /`transfers\.execute`/);
    assert.doesNotMatch(searchText(PAGE, STABLE), /Issuance|Stripe/);
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
