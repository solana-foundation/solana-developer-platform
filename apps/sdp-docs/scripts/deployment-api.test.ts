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
  const sample = `\`\`\`bash tab="cURL"\ncurl '${canonicalSite.apiUrl}/v1/widgets/wdg_1'\n\`\`\`\n`;
  const compiled = (path: string) => {
    const processor = unified().use(remarkParse).use(remarkMdx).use(blocks.remarkDocsBlocks);
    const tree = processor.parse(sample);
    processor.runSync(tree, { path });
    return JSON.stringify(tree);
  };
  return { canonicalSite, expandDocsBlocks: blocks.expandDocsBlocks, sample, compiled };
}

describe("the samples' API", () => {
  it("is this deployment's on a generated reference page, and only there", async () => {
    const { canonicalSite, compiled } = await loadDocs();
    const reference = compiled("/repo/apps/sdp-docs/content/docs/reference/api/widgets/get.mdx");
    assert.ok(reference.includes(`${DEPLOYMENT_API}/v1/widgets/wdg_1`));
    assert.ok(!reference.includes(canonicalSite.apiUrl));
    const guide = compiled("/repo/apps/sdp-docs/content/docs/guides/widgets.mdx");
    assert.ok(guide.includes(`${canonicalSite.apiUrl}/v1/widgets/wdg_1`));
  });

  it("stays canonical in the Markdown agents and the llms files get", async () => {
    const { expandDocsBlocks, sample } = await loadDocs();
    assert.equal(expandDocsBlocks(sample, "content/docs/reference/api/widgets/get.mdx"), sample);
  });
});
