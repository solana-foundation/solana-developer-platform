import assert from "node:assert/strict";
import { describe, it } from "node:test";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { developmentNoticeMarkdown } from "@/lib/development-notice";
import { expandDocsBlocks, remarkDocsBlocks } from "@/lib/docs-blocks";

describe("presentation Markdown", () => {
  const stages = ["Preview", "Build", "Sign", "Submit"];
  const fences = stages.map(
    (stage) => `\`\`\`ts title="${stage}"\nconst stage = ${JSON.stringify(stage)};\n\`\`\``
  );
  const tabs = [
    '<Tabs items={["Preview", "Build", "Sign", "Submit"]} defaultIndex={0}>',
    ...stages.map((stage, index) => `<Tab value="${stage}">\n\n${fences[index]}\n\n</Tab>`),
    "</Tabs>",
  ].join("\n\n");

  it("includes every ordered stage and exact code fence with one Earn notice", () => {
    const source = `---\nmodule: earn\ntitle: Deposit\n---\n\n## Make a deposit\n\n${tabs}\n`;
    const markdown = expandDocsBlocks(source, "earn/quickstart.mdx");
    assert.doesNotMatch(markdown, /<\/?Tabs?\b/);
    const labels = stages.map((stage) => markdown.indexOf(`**${stage}**`));
    assert.deepEqual(
      labels,
      [...labels].sort((left, right) => left - right)
    );
    for (const [index, stage] of stages.entries()) {
      assert.ok(labels[index] >= 0);
      assert.ok(markdown.includes(fences[index]));
      assert.ok(markdown.indexOf(fences[index]) > markdown.indexOf(`**${stage}**`));
    }
    assert.deepEqual(markdown.match(/^#+ .+$/gm), ["## Make a deposit"]);
    const notice = developmentNoticeMarkdown("Earn");
    assert.equal(markdown.split(notice).length - 1, 1);
    assert.ok(markdown.indexOf(notice) < markdown.indexOf("## Make a deposit"));
    assert.equal(expandDocsBlocks(markdown, "earn/quickstart.mdx"), markdown);
  });

  it("keeps nested UI and API alternatives without evaluating UI expressions", () => {
    const source = [
      '<Tabs items={(() => { throw new Error("do not evaluate"); })()} groupId="flow">',
      '<Tab value="UI" className={someUiClass}>',
      "Click Deposit.",
      "</Tab>",
      '<Tab value="API">',
      '<Tabs items={["curl", "TypeScript"]}>',
      '<Tab value="curl">',
      '```bash\ncurl "https://api.solana.com/v1/earn/strategies"\n```',
      "</Tab>",
      '<Tab value="TypeScript">',
      '```ts\nconst example = "<Tab value=\\"literal\\">";\n```',
      "</Tab>",
      "</Tabs>",
      "</Tab>",
      "</Tabs>",
    ].join("\n\n");
    const markdown = expandDocsBlocks(source, "nested.mdx");
    assert.match(markdown, /\*\*UI\*\*[\s\S]*Click Deposit\.[\s\S]*\*\*API\*\*/);
    assert.match(markdown, /\*\*API\*\*[\s\S]*\*\*curl\*\*[\s\S]*\*\*TypeScript\*\*/);
    assert.ok(markdown.includes('const example = "<Tab value=\\"literal\\">";'));
    assert.doesNotMatch(markdown, /do not evaluate|someUiClass|<Tabs/);
  });

  it("preserves internal-only callout text, type, title, and code", () => {
    const fence = '```json\n{"internal": true}\n```';
    const source = [
      '<Callout type="info" title="Internal API">',
      "This operation is internal. It is not part of the partner-facing Earn API.",
      fence,
      "</Callout>",
    ].join("\n\n");
    const markdown = expandDocsBlocks(source, "reference/api/earn/internal.mdx");
    assert.match(markdown, /\*\*Internal API \(info\)\*\*/);
    assert.match(
      markdown,
      /This operation is internal\. It is not part of the partner-facing Earn API\./
    );
    assert.ok(markdown.includes(fence));
    assert.ok(markdown.includes(developmentNoticeMarkdown("Earn")));
    assert.doesNotMatch(markdown, /<\/?Callout/);
  });

  it("refuses dynamic or missing labels and escapes Markdown in literal labels", () => {
    for (const source of [
      "<Tab value={stage}>\n\nContent.\n\n</Tab>",
      "<Tab>\n\nContent.\n\n</Tab>",
      '<Tab value="Preview" {...props}>\n\nContent.\n\n</Tab>',
      "<Callout title={title}>\n\nContent.\n\n</Callout>",
    ]) {
      assert.throws(() => expandDocsBlocks(source, "dynamic.mdx"), /string|spread/);
    }
    const markdown = expandDocsBlocks(
      '<Tab value="[Preview] *safely* {literal}">\n\nContent.\n\n</Tab>',
      "literal.mdx"
    );
    assert.ok(markdown.includes("**\\[Preview\\] \\*safely\\* \\{literal\\}**"));
  });

  it("leaves the rendered MDX component tree unchanged", () => {
    const processor = unified().use(remarkParse).use(remarkMdx);
    const before = processor.parse(tabs);
    const expected = JSON.stringify(before);
    const renderer = unified().use(remarkParse).use(remarkMdx).use(remarkDocsBlocks);
    assert.equal(JSON.stringify(renderer.runSync(before)), expected);
    assert.equal(before.children[0]?.type, "mdxJsxFlowElement");
  });
});
