import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

const docsDir = fileURLToPath(new URL("../content/docs/", import.meta.url));
const MAX_DESCRIPTION_CHARS = 130;
const MAX_PARAGRAPH_WORDS = 80;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

type Issue = { line: number; message: string };

function textOf(node: Root | RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map((child) => textOf(child)).join(" ");
  return "";
}

function inspect(source: string): Issue[] {
  const issues: Issue[] = [];
  const frontmatter = source.match(FRONTMATTER);
  const metadata: unknown = frontmatter?.[1] ? parseYaml(frontmatter[1]) : null;
  if (metadata && typeof metadata === "object" && "description" in metadata) {
    const description = metadata.description;
    if (typeof description === "string" && [...description].length > MAX_DESCRIPTION_CHARS) {
      issues.push({
        line: 1,
        message: `description has ${[...description].length} characters (max ${MAX_DESCRIPTION_CHARS})`,
      });
    }
  }

  const offset = frontmatter ? frontmatter[0].split("\n").length - 1 : 0;
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const tree = parser.parse(body) as Root;

  function visit(node: Root | RootContent): void {
    if (node.type === "paragraph") {
      const count = textOf(node).match(WORD)?.length ?? 0;
      if (count > MAX_PARAGRAPH_WORDS) {
        issues.push({
          line: (node.position?.start.line ?? 1) + offset,
          message: `paragraph has ${count} words (max ${MAX_PARAGRAPH_WORDS})`,
        });
      }
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }

  visit(tree);
  return issues;
}

async function listMdx(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMdx(file);
      return entry.name.endsWith(".mdx") ? [file] : [];
    })
  );
  return nested.flat();
}

async function main(): Promise<void> {
  const files = (await listMdx(docsDir)).filter(
    (file) => !path.relative(docsDir, file).startsWith(`reference${path.sep}api${path.sep}`)
  );
  const results = await Promise.all(
    files.map(async (file) => ({ file, issues: inspect(await fs.readFile(file, "utf8")) }))
  );
  const failures = results.flatMap(({ file, issues }) =>
    issues.map(({ line, message }) => `${path.relative(docsDir, file)}:${line}: ${message}`)
  );
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Checked prose in ${files.length} hand-authored docs pages.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
