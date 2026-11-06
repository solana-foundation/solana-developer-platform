import assert from "node:assert/strict";
import { describe, it } from "node:test";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { expandDocsBlocks, remarkDocsBlocks } from "@/lib/docs-blocks";

describe("guide layouts", () => {
  it("includes a collapsed helper and its summary in Markdown", () => {
    const source = [
      "<details>",
      "<summary>Show the complete earn-api.ts helper</summary>",
      "",
      '```typescript title="earn-api.ts"',
      "export async function earnRequest() {}",
      "```",
      "",
      "</details>",
    ].join("\n");
    const markdown = expandDocsBlocks(source, "guide.mdx");
    assert.doesNotMatch(markdown, /<\/?(?:details|summary)>/);
    assert.match(markdown, /Show the complete earn-api\.ts helper/);
    assert.match(
      markdown,
      /```typescript title="earn-api\.ts"\nexport async function earnRequest\(\) \{\}\n```/
    );
  });

  it("keeps the diagram and guide choices readable in Markdown", () => {
    const source = [
      "<EarnFlow>",
      "",
      "1. **Deposit** stablecoins.",
      "2. **Hold** shares.",
      "3. **Withdraw** available funds.",
      "",
      "</EarnFlow>",
      "",
      "<GuideCards>",
      "",
      "- [Treasury](/docs/earn/treasury): organization custody wallets.",
      "",
      "</GuideCards>",
    ].join("\n");
    const markdown = expandDocsBlocks(source, "guide.mdx");
    assert.doesNotMatch(markdown, /EarnFlow|GuideCards/);
    assert.match(markdown, /1\. \*\*Deposit\*\* stablecoins\./);
    assert.match(markdown, /3\. \*\*Withdraw\*\* available funds\./);
    assert.match(markdown, /\[Treasury\]\(\/docs\/earn\/treasury\)/);

    const processor = unified().use(remarkParse).use(remarkMdx).use(remarkDocsBlocks);
    const tree = processor.parse(source);
    processor.runSync(tree, { value: source });
    const [flow] = tree.children;
    assert.equal(flow?.type, "mdxJsxFlowElement");
    if (flow?.type !== "mdxJsxFlowElement") return;
    assert.equal(flow.children[0]?.type, "list");
  });
});
