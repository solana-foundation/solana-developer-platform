import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandDocsBlocks } from "@/lib/docs-blocks";
import { isPageSourcePublished, type PublicSurface, publicSurface } from "@/lib/release-channel";
import {
  buildSections,
  type DocsMeta,
  type DocsPage,
  EARN_KEY_PAGE_SLUGS,
  selectKeyPages,
} from "./lib/ai-resource-pages.js";

function pagesOf(...slugs: string[]): Map<string, DocsPage> {
  return new Map(
    slugs.map((slug) => [
      slug,
      { slug, title: slug, description: "", content: "", url: `/docs/${slug}`, shared: false },
    ])
  );
}

describe("AI discovery page selection", () => {
  it("follows relative metadata links in section order without duplicating a guide", () => {
    const pages = pagesOf("introduction", "earn/index", "earn/quickstart", "guides/embedded-yield");
    const folders = new Map<string, DocsMeta>([
      ["earn", { title: "Earn", pages: ["../guides/embedded-yield", "quickstart"] }],
    ]);
    const sections = buildSections({ pages: ["earn", "guides/embedded-yield"] }, pages, folders);

    assert.deepEqual(
      sections.find(({ title }) => title === "Earn")?.pages.map(({ slug }) => slug),
      ["earn/index", "guides/embedded-yield", "earn/quickstart"]
    );
    assert.deepEqual(
      sections.flatMap(({ pages }) => pages.map(({ slug }) => slug)),
      ["introduction", "earn/index", "guides/embedded-yield", "earn/quickstart"]
    );
  });

  it("includes every admitted page once even when navigation omits its page or folder", () => {
    const pages = pagesOf("introduction", "earn/index", "earn/unlisted", "without-meta/page");
    const sections = buildSections(
      { pages: ["earn", "earn/index", "earn/held"] },
      pages,
      new Map([["earn", { title: "Earn", pages: ["index"] }]]),
      new Set(["earn/held"])
    );
    const slugs = sections.flatMap(({ pages }) => pages.map(({ slug }) => slug));

    assert.equal(slugs.length, pages.size);
    assert.equal(new Set(slugs).size, pages.size);
    assert.deepEqual([...slugs].sort(), [...pages.keys()].sort());
    assert.equal(slugs.includes("earn/held"), false);
  });

  it("keeps grouped API operations in their named section", () => {
    const pages = pagesOf("introduction", "reference/api/earn/index", "reference/api/earn/deposit");
    const sections = buildSections(
      { pages: ["reference/api/earn"] },
      pages,
      new Map([
        ["reference/api/earn", { title: "Earn", pages: ["(deposits)"] }],
        ["reference/api/earn/(deposits)", { title: "Deposits", pages: ["deposit"] }],
      ])
    );

    assert.deepEqual(
      sections.find(({ title }) => title === "Earn: Deposits")?.pages.map(({ slug }) => slug),
      ["reference/api/earn/deposit"]
    );
    assert.equal(sections.flatMap(({ pages }) => pages).length, pages.size);
  });

  it("skips channel-excluded Earn pages and discovers the four guides when admitted", () => {
    const unpublished = pagesOf("introduction");
    assert.deepEqual(selectKeyPages(unpublished, ["introduction"], EARN_KEY_PAGE_SLUGS), [
      unpublished.get("introduction"),
    ]);

    const published = pagesOf(
      "introduction",
      "earn/index",
      "earn/quickstart",
      "earn/concepts",
      "guides/embedded-yield"
    );
    assert.deepEqual(
      selectKeyPages(published, ["introduction", "earn/index"], EARN_KEY_PAGE_SLUGS).map(
        ({ slug }) => slug
      ),
      ["introduction", "earn/index", "earn/quickstart", "earn/concepts", "guides/embedded-yield"]
    );
    assert.throws(
      () => selectKeyPages(unpublished, ["missing-required-page"], EARN_KEY_PAGE_SLUGS),
      /Missing required key docs page "missing-required-page"/
    );
  });

  it("admits custody setup guides and their shared links only through the provider gate", () => {
    const slug = "wallet-operations/fireblocks";
    const raw =
      "---\ntitle: Connect Fireblocks\ncustodyProvider: fireblocks\n---\nFireblocks setup.\n";
    for (const releaseChannel of ["stable", "beta"] as const) {
      const published = releaseChannel === "beta";
      const surface: PublicSurface = {
        ...publicSurface,
        releaseChannel,
        custodyProviders: published ? ["privy", "fireblocks"] : ["privy"],
      };
      const pages = pagesOf("introduction", "wallet-operations/index");
      if (isPageSourcePublished(raw, `${slug}.mdx`, surface)) {
        const [guide] = pagesOf(slug).values();
        if (!guide) throw new Error("Missing Fireblocks test page");
        pages.set(slug, guide);
      }
      const sections = buildSections(
        { pages: ["wallet-operations"] },
        pages,
        new Map([["wallet-operations", { title: "Wallets", pages: ["index", "fireblocks"] }]]),
        published ? new Set() : new Set([slug])
      );
      const corpusSlugs = sections.flatMap(({ pages }) => pages.map(({ slug }) => slug));
      assert.equal(corpusSlugs.includes(slug), published);
      const links = expandDocsBlocks("<CustodyProviderGuides />\n", "wallets.mdx", { surface });
      assert.equal(links.includes(`/docs/${slug}`), published);
    }
  });

  it("keeps Earn capability text behind the existing public-surface gate", () => {
    const held: PublicSurface = {
      ...publicSurface,
      modules: publicSurface.modules.filter((module) => module !== "earn"),
    };
    const published: PublicSurface = { ...held, modules: [...held.modules, "earn"] };
    const source = "<ModuleTable />\n\n<ModuleCapabilities />\n";

    const hidden = expandDocsBlocks(source, "overview.mdx", { surface: held });
    assert.doesNotMatch(
      hidden,
      /\*\*Earn\*\*|DeFi and RWA strategies, customer-signed transactions/
    );

    const visible = expandDocsBlocks(source, "overview.mdx", { surface: published });
    assert.match(visible, /\*\*Earn\*\*/);
    assert.match(visible, /DeFi and RWA strategies, customer-signed transactions, and positions/);
  });
});
