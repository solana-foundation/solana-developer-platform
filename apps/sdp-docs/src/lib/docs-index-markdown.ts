import type { Item, Node, Root } from "fumadocs-core/page-tree";

type Describe = (url: string) => string | undefined;

/**
 * The docs home as Markdown, served at `/docs.md`. The home page renders
 * `DocsHome` and has no Markdown body, so this is its title and description
 * followed by the navigation it leads into: every page under its folder and
 * separator headings, with the page's description.
 *
 * @param home - The home page's frontmatter title and description.
 * @param tree - The docs page tree, already narrowed to the release channel.
 * @param describe - The description of the page at a URL, if it has one.
 * @returns The Markdown document.
 */
export function renderDocsIndexMarkdown(
  home: { title?: string; description?: string },
  tree: Root,
  describe: Describe
): string {
  const lines: string[] = [];
  if (home.title) lines.push(`# ${singleLine(home.title)}`, "");
  if (home.description) lines.push(singleLine(home.description), "");
  appendNodes(lines, tree.children, 2, describe);
  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${markdown}\n`;
}

function appendNodes(lines: string[], nodes: Node[], depth: number, describe: Describe): void {
  for (const node of nodes) {
    if (node.type === "page") {
      lines.push(pageLine(node, describe));
      continue;
    }
    if (node.name) {
      lines.push("", `${"#".repeat(Math.min(depth, 6))} ${singleLine(String(node.name))}`, "");
    }
    if (node.type === "folder") {
      if (node.index) lines.push(pageLine(node.index, describe));
      appendNodes(lines, node.children, depth + 1, describe);
    }
  }
}

function pageLine(item: Item, describe: Describe): string {
  const link = `- [${singleLine(String(item.name))}](${item.url})`;
  const description = describe(item.url);
  return description ? `${link}: ${singleLine(description)}` : link;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
