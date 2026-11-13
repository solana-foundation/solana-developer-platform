import assert from "node:assert/strict";
import { describe, it } from "node:test";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

// A page reads this deployment's URLs where it swaps them in (`apiUrl` and `docsUrl` in
// src/lib/site.ts, from the environment), so this file sets the variables before it loads what
// reads them. node:test runs each file in its own process, so no other test sees them.
const DEPLOYMENT_API = "https://api.stage.example";
const DEPLOYMENT_DOCS = "https://stage.example/docs";
process.env.NEXT_PUBLIC_SDP_API_URL = DEPLOYMENT_API;
process.env.NEXT_PUBLIC_SDP_DOCS_URL = DEPLOYMENT_DOCS;

async function loadDocs() {
  const [{ canonicalSite }, blocks, deployment] = await Promise.all([
    import("@/lib/site"),
    import("@/lib/docs-blocks"),
    import("@/lib/deployment-api"),
  ]);
  /** A page that names the API in prose, in a link and in a fence. */
  const page = (api: string, prose = canonicalSite.apiUrl) =>
    [
      `The canonical API is \`${prose}\`.`,
      "",
      `Read the [OpenAPI document](${api}/openapi.json).`,
      "",
      '```bash tab="cURL"',
      `curl '${api}/v1/widgets/wdg_1'`,
      "```",
      "",
    ].join("\n");
  const compiled = (path: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMdx)
      .use(blocks.remarkDocsBlocks);
    const tree = processor.parse(page(canonicalSite.apiUrl));
    processor.runSync(tree, { path });
    return JSON.stringify(tree);
  };
  return { canonicalSite, blocks, deployment, page, compiled };
}

describe("the samples' API", () => {
  it("is this deployment's in a page's code and links, on a reference page and a guide", async () => {
    const { canonicalSite, compiled } = await loadDocs();
    for (const path of [
      "/repo/apps/sdp-docs/content/docs/reference/api/widgets/get.mdx",
      "/repo/apps/sdp-docs/content/docs/guides/widgets.mdx",
    ]) {
      const shown = compiled(path);
      assert.ok(shown.includes(`${DEPLOYMENT_API}/v1/widgets/wdg_1`), path);
      assert.ok(shown.includes(`"url":"${DEPLOYMENT_API}/openapi.json"`), path);
      assert.ok(!shown.includes(`${canonicalSite.apiUrl}/`), path);
      // Inline code names the canonical API on purpose, so it keeps the host its author wrote.
      assert.ok(shown.includes(`"value":"${canonicalSite.apiUrl}"`), path);
    }
  });

  it("is this deployment's in the Markdown a page serves, as Copy page copies it", async () => {
    const { canonicalSite, deployment, page } = await loadDocs();
    assert.equal(deployment.pointAtApi(page(canonicalSite.apiUrl)), page(DEPLOYMENT_API));
  });

  it("follows fences in list items, tilde fences and longer fences", async () => {
    const { canonicalSite, deployment } = await loadDocs();
    const sample = (api: string, prose: string) =>
      [
        `1. Call \`${prose}\`:`,
        "",
        "   ```bash",
        `   curl ${api}/health`,
        "   ```",
        "",
        "~~~text",
        `${api}/v1/a`,
        "~~~",
        "",
        "````markdown",
        "```bash",
        `curl ${api}/v1/b`,
        "```",
        "````",
        "",
        `- API: ${api}`,
      ].join("\n");
    assert.equal(
      deployment.pointAtApi(sample(canonicalSite.apiUrl, canonicalSite.apiUrl)),
      sample(DEPLOYMENT_API, canonicalSite.apiUrl)
    );
  });

  it("serves the llms files with this deployment's docs, skill and API URLs", async () => {
    const { canonicalSite, deployment } = await loadDocs();
    const llms = (docs: string, origin: string, api: string) =>
      [
        `- Docs: ${docs}`,
        `- API: ${api}`,
        `- [Quickstart](${docs}/earn/quickstart): three requests.`,
        `- [Docs index](${docs}.md)`,
        `- [Skill](${origin}/SKILL.md)`,
        "",
        "```bash",
        `curl ${api}/v1/earn/strategies`,
        "```",
        "",
        // Account and dashboard links stay on the canonical site (src/lib/dashboard-links.ts).
        `Sign in at ${canonicalSite.docsOrigin}/sign-up or open ${canonicalSite.docsOrigin}/dashboard.`,
      ].join("\n");
    assert.equal(
      deployment.llmsForDeployment(
        llms(canonicalSite.docsUrl, canonicalSite.docsOrigin, canonicalSite.apiUrl)
      ),
      llms(DEPLOYMENT_DOCS, new URL(DEPLOYMENT_DOCS).origin, DEPLOYMENT_API)
    );
  });

  it("stays canonical in the Markdown the committed llms files are built from", async () => {
    const { canonicalSite, blocks, page } = await loadDocs();
    const source = page(canonicalSite.apiUrl);
    assert.equal(
      blocks.expandDocsBlocks(source, "content/docs/reference/api/widgets/get.mdx"),
      source
    );
  });
});
