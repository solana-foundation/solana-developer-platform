import type { Nodes, Parent, Root, RootContent } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  DOCS_MODULES,
  DOCS_OPERATION_FAMILIES,
  DOCS_RAMP_PROVIDERS,
  type ModuleEntry,
  publishedRampProviderIds,
  ROTATE_PROVIDERS_TOKEN,
} from "./docs-catalog";
import {
  frontmatterOf,
  isGatePublished,
  isModulePublished,
  type PublicSurface,
  publicSurface,
} from "./release-channel";

/**
 * Generated blocks. A page about one module carries `module:` (or
 * `rampProvider:`) frontmatter; a shared page never names a module itself and
 * instead places a block that lists what the build publishes:
 *
 * - `<ModuleTable />`: the modules, with what each does.
 * - `<ModuleCapabilities />`: one capability line per module (the AI guide).
 * - `<RampProviderMatrix />`: the ramp providers, each linking to its page.
 * - `<AllowedOperationsTable />`: API-key operation families and their types.
 *
 * Each block is rendered once, to Markdown, from docs-catalog.ts and the
 * build's manifest. `remarkDocsBlocks` swaps it into the MDX tree before
 * Fumadocs extracts headings and search text; `expandDocsBlocks` swaps the same
 * Markdown into raw MDX for the llms files, the Markdown route and the link
 * checker. Both use one string, so the page and its text agree by construction.
 */

const escapeCell = (value: string) => value.replace(/\|/g, "\\|");

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const publishedModules = (surface: PublicSurface): ModuleEntry[] =>
  DOCS_MODULES.filter(
    (entry) => entry.module === "core" || isModulePublished(entry.module, surface)
  );

const BLOCKS: Record<string, (surface: PublicSurface) => string> = {
  ModuleTable: (surface) =>
    table(
      ["Module", "What it does"],
      publishedModules(surface)
        .filter((entry) => entry.module !== "core")
        .map((entry) => [`**${entry.name}**`, entry.summary])
    ),
  ModuleCapabilities: (surface) =>
    publishedModules(surface)
      .map((entry) => `- ${entry.capability}`)
      .join("\n"),
  RampProviderMatrix: (surface) =>
    table(
      ["Provider", "Onramp", "Offramp", "Sandbox", "Delivery mode", "Best for", "Notes"],
      DOCS_RAMP_PROVIDERS.filter((entry) =>
        isGatePublished({ rampProvider: entry.provider }, surface)
      ).map((entry) => [
        `[${entry.name}](/docs/payments/ramps-${entry.provider})`,
        entry.onramp,
        entry.offramp,
        entry.sandbox,
        `\`${entry.deliveryMode}\``,
        entry.bestFor,
        entry.notes,
      ])
    ),
  AllowedOperationsTable: (surface) =>
    table(
      ["Family", "Covers", "Operation types"],
      surface.allowedOperations.map(({ family, types }) => [
        `\`${family}\``,
        DOCS_OPERATION_FAMILIES[family] ?? family,
        types.map((type) => `\`${type}\``).join(", "),
      ])
    ),
};

function blockName(node: Nodes): string | undefined {
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return undefined;
  return node.name !== null && node.name in BLOCKS ? node.name : undefined;
}

function renderBlock(node: Nodes, where: string, surface: PublicSurface): string {
  const name = blockName(node) as string;
  const element = node as MdxJsxFlowElement;
  if (node.type !== "mdxJsxFlowElement" || element.attributes.length > 0) {
    throw new Error(`${where}: <${name} /> stands on its own line and takes no attributes`);
  }
  return BLOCKS[name]?.(surface) ?? "";
}

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

/** Remark plugin for the Fumadocs MDX pipeline; source.config.ts runs it first. */
export function remarkDocsBlocks(options: { surface?: PublicSurface } = {}) {
  const surface = options.surface ?? publicSurface;
  return (tree: Root, file: { path?: string }) => {
    const where = file.path ?? "MDX page";
    const walk = (parent: Parent) => {
      parent.children = (parent.children as Nodes[]).flatMap((child) => {
        if (blockName(child)) {
          return (parser.parse(renderBlock(child, where, surface)) as Root).children;
        }
        if ("children" in child) walk(child);
        return [child];
      }) as RootContent[];
    };
    walk(tree);
  };
}

/** Expands a page's generated blocks in its raw MDX, keeping everything else byte for byte. */
export function expandDocsBlocks(
  source: string,
  where: string,
  options: { surface?: PublicSurface } = {}
): string {
  const surface = options.surface ?? publicSurface;
  // Frontmatter is not MDX; blank it (keeping offsets) for the parse.
  const { raw } = frontmatterOf(source);
  const tree = parser.parse(raw.replace(/[^\n]/g, " ") + source.slice(raw.length)) as Root;
  const blocks: { start: number; end: number; markdown: string }[] = [];
  const [leadProvider] = publishedRampProviderIds(surface.rampProviders);
  const walk = (parent: Parent) => {
    for (const child of parent.children as Nodes[]) {
      if (child.type === "code" && child.meta?.includes("rotate-providers") && leadProvider) {
        // The page rotates this fence's provider; text names the first published one.
        const start = child.position?.start.offset ?? 0;
        const end = child.position?.end.offset ?? 0;
        const markdown = source
          .slice(start, end)
          .replaceAll(ROTATE_PROVIDERS_TOKEN, `"${leadProvider}"`);
        blocks.push({ start, end, markdown });
      } else if (blockName(child)) {
        blocks.push({
          start: child.position?.start.offset ?? 0,
          end: child.position?.end.offset ?? 0,
          markdown: renderBlock(child, where, surface),
        });
      } else if ("children" in child) {
        walk(child);
      }
    }
  };
  walk(tree);
  let result = source;
  for (const block of blocks.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, block.start) + block.markdown + result.slice(block.end);
  }
  return result;
}
