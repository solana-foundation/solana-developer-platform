import assert from "node:assert/strict";
import { describe, it } from "node:test";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

// A page reads this deployment's API where it swaps the host (`apiUrl` in src/lib/site.ts, from
// the environment), so this file sets the variable before it loads what reads it. node:test runs
// each file in its own process, so no other test sees it.
const DEPLOYMENT_API = "https://api.stage.example";
process.env.NEXT_PUBLIC_SDP_API_URL = DEPLOYMENT_API;

async function loadDocs() {
  const [{ canonicalSite }, blocks] = await Promise.all([
    import("@/lib/site"),
    import("@/lib/docs-blocks"),
  ]);
  const prose = `The canonical API is \`${canonicalSite.apiUrl}\`.\n\n`;
  const fence = (api: string) => `\`\`\`bash tab="cURL"\ncurl '${api}/v1/widgets/wdg_1'\n\`\`\`\n`;
  const sample = prose + fence(canonicalSite.apiUrl);
  const compiled = (path: string) => {
    const processor = unified().use(remarkParse).use(remarkMdx).use(blocks.remarkDocsBlocks);
    const tree = processor.parse(sample);
    processor.runSync(tree, { path });
    return JSON.stringify(tree);
  };
  return { canonicalSite, blocks, sample, deployed: prose + fence(DEPLOYMENT_API), compiled };
}

describe("the samples' API", () => {
  it("is this deployment's in a page's fenced code, on a reference page and a guide", async () => {
    const { canonicalSite, compiled } = await loadDocs();
    for (const path of [
      "/repo/apps/sdp-docs/content/docs/reference/api/widgets/get.mdx",
      "/repo/apps/sdp-docs/content/docs/guides/widgets.mdx",
    ]) {
      const page = compiled(path);
      assert.ok(page.includes(`${DEPLOYMENT_API}/v1/widgets/wdg_1`), path);
      assert.ok(!page.includes(`${canonicalSite.apiUrl}/v1/widgets`), path);
      // Prose names the canonical API on purpose, so it keeps the host its author wrote.
      assert.ok(page.includes(`"value":"${canonicalSite.apiUrl}"`), path);
    }
  });

  it("is this deployment's in the Markdown a page serves, as Copy page copies it", async () => {
    const { blocks, sample, deployed } = await loadDocs();
    assert.equal(blocks.pointCodeAtApi(sample, "content/docs/guides/widgets.mdx"), deployed);
  });

  it("stays canonical in the Markdown the llms files get", async () => {
    const { blocks, sample } = await loadDocs();
    assert.equal(
      blocks.expandDocsBlocks(sample, "content/docs/reference/api/widgets/get.mdx"),
      sample
    );
  });
});
