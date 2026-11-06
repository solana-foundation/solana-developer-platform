import { promises as fs } from "node:fs";
import path from "node:path";
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
import { docsPageSlugOf, getDocsPagePath } from "@/lib/site";
import { inspectProse } from "./check-prose";

const root = fileURLToPath(new URL("../content/", import.meta.url));
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

/** Checks future guide/reference links without publishing drafts to the site. */
async function main(): Promise<void> {
  const published = await mdxFiles(path.join(root, "docs"));
  const unpublished = await mdxFiles(path.join(root, "unpublished"));
  const drafts = unpublished.filter((file) => {
    const relative = path.relative(path.join(root, "unpublished"), file);
    return (
      relative.startsWith(`earn${path.sep}`) ||
      relative.startsWith(`reference${path.sep}api${path.sep}earn${path.sep}`) ||
      relative === `guides${path.sep}embedded-yield.mdx`
    );
  });
  const pages = new Map<string, string>();
  for (const file of [...published, ...unpublished]) {
    const relative = path.relative(root, file).split(path.sep).slice(1).join("/");
    const href = getDocsPagePath(docsPageSlugOf(relative)).replace(/\/$/, "");
    if (pages.has(href)) throw new Error(`Duplicate published/draft page: ${href}`);
    pages.set(href, file);
  }

  const problems: string[] = [];
  for (const file of drafts) {
    const source = await fs.readFile(file, "utf8");
    const label = path.relative(root, file);
    const header = source.match(frontmatter)?.[1];
    if (!header || !gateSchema.safeParse(parseYaml(header)).success) {
      problems.push(`${label}: missing module: earn gate`);
    }
    const generated = label.startsWith("unpublished/reference/api/");
    if (generated) {
      // Parse generated MDX too; its prose length is owned by OpenAPI.
      inspectProse(source);
    } else {
      for (const issue of inspectProse(source)) {
        problems.push(`${label}:${issue.line}: ${issue.message}`);
      }
    }
    const markdown = expandDocsBlocks(source, file);
    const original = readableContent(parser.parse(source.replace(frontmatter, "")));
    const rendered = readableContent(parser.parse(markdown.replace(frontmatter, "")));
    if (JSON.stringify(original.code) !== JSON.stringify(rendered.code)) {
      problems.push(`${label}: Markdown changed or dropped a code example`);
    }
    const renderedText = rendered.text.join(" ");
    if (original.text.some((text) => text && !renderedText.includes(text))) {
      problems.push(`${label}: Markdown dropped source text`);
    }
    if (rendered.containsJsx) problems.push(`${label}: Markdown still contains UI markup`);
    if (!markdown.includes(developmentNoticeMarkdown("Earn"))) {
      problems.push(`${label}: Markdown is missing the Earn development notice`);
    }
    const prose = source.replace(/```[\s\S]*?```/g, "");
    for (const match of prose.matchAll(/\[[^\]]*\]\((\/docs(?:\/[^\s)#]*)?)?(?:#[^)]*)?\)/g)) {
      const href = match[1]?.split("?", 1)[0]?.replace(/\.md$/, "").replace(/\/$/, "");
      if (href && !pages.has(href)) problems.push(`${label}: missing future page ${href}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(
    `Checked ${drafts.length} unpublished Earn pages: gates, MDX, prose, future links, and Markdown parity.`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
