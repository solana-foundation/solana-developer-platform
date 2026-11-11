import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Parent, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { developmentNoticeMarkdown } from "@/lib/development-notice";
import { expandDocsBlocks } from "@/lib/docs-blocks";

const root = fileURLToPath(new URL("../content/docs/", import.meta.url));
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const gateSchema = z.object({ module: z.literal("earn") });
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

function readableContent(tree: Root) {
  const code: { language: string | null; metadata: string | null; value: string }[] = [];
  const text: string[] = [];
  let containsJsx = false;
  const walk = (parent: Parent) => {
    for (const node of parent.children) {
      if (node.type === "code") {
        code.push({ language: node.lang ?? null, metadata: node.meta ?? null, value: node.value });
      } else if (node.type === "text" || node.type === "inlineCode") {
        text.push(node.value.replace(/\s+/g, " ").trim());
      } else if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        containsJsx = true;
      }
      if ("children" in node) walk(node);
    }
  };
  walk(tree);
  return { code, text, containsJsx };
}

async function mdxFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory()
        ? mdxFiles(file)
        : Promise.resolve(entry.name.endsWith(".mdx") ? [file] : []);
    })
  );
  return files.flat();
}

describe("published Earn guide sources", () => {
  it("keeps the normal module gate and complete Markdown examples", async () => {
    const files = [
      ...(await mdxFiles(path.join(root, "earn"))),
      path.join(root, "guides/embedded-yield.mdx"),
    ];
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      const header = source.match(frontmatter)?.[1];
      assert.ok(header, `${file}: missing frontmatter`);
      assert.equal(gateSchema.safeParse(parseYaml(header)).success, true, file);
      const markdown = expandDocsBlocks(source, file);
      const original = readableContent(parser.parse(source.replace(frontmatter, "")));
      const rendered = readableContent(parser.parse(markdown.replace(frontmatter, "")));
      assert.deepEqual(rendered.code, original.code, `${file}: changed code examples`);
      const renderedText = rendered.text.join(" ");
      for (const text of original.text) {
        assert.ok(!text || renderedText.includes(text), `${file}: dropped text ${text}`);
      }
      assert.equal(rendered.containsJsx, false, `${file}: Markdown contains UI markup`);
      assert.ok(markdown.includes(developmentNoticeMarkdown("Earn")), file);
    }
  });
});
