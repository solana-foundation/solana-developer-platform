import type { OperationFamily } from "@sdp/types";
import type { Parent, Root, RootContent } from "mdast";
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

// Backslashes first, so an escaped pipe cannot be un-escaped by the cell text.
const escapeCell = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const publishedModules = (surface: PublicSurface): ModuleEntry[] =>
  DOCS_MODULES.filter(
    (entry) => entry.module === "core" || isModulePublished(entry.module, surface)
  );

const BLOCKS = {
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
      // Per-provider notes live on each provider's page; the matrix stays scannable.
      ["Provider", "Onramp", "Offramp", "Sandbox", "Delivery mode", "Best for"],
      DOCS_RAMP_PROVIDERS.filter((entry) =>
        isGatePublished({ rampProvider: entry.provider }, surface)
      ).map((entry) => [
        `[${entry.name}](/docs/payments/ramps-${entry.provider})`,
        entry.onramp,
        entry.offramp,
        entry.sandbox,
        `\`${entry.deliveryMode}\``,
        entry.bestFor,
      ])
    ),
  AllowedOperationsTable: (surface) =>
    table(
      ["Family", "Covers", "Operation types"],
      // Families in the catalog's reading order (payment first).
      [...surface.allowedOperations]
        .sort((left, right) => familyRank(left.family) - familyRank(right.family))
        .map(({ family, types }) => [
          `\`${family}\``,
          DOCS_OPERATION_FAMILIES[family],
          types.map((type) => `\`${type}\``).join(", "),
        ])
    ),
} satisfies Record<string, (surface: PublicSurface) => string>;

type BlockName = keyof typeof BLOCKS;

const FAMILY_ORDER: readonly OperationFamily[] = Object.keys(DOCS_OPERATION_FAMILIES).filter(
  (family): family is OperationFamily => Object.hasOwn(DOCS_OPERATION_FAMILIES, family)
);

function familyRank(family: OperationFamily): number {
  return FAMILY_ORDER.indexOf(family);
}

function isBlockName(name: string | null): name is BlockName {
  return name !== null && Object.hasOwn(BLOCKS, name);
}

/** A generated block's element and name, or undefined for any other node. */
function blockOf(node: RootContent, where: string): { name: BlockName } | undefined {
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return undefined;
  if (!isBlockName(node.name)) return undefined;
  if (node.type !== "mdxJsxFlowElement" || node.attributes.length > 0) {
    throw new Error(`${where}: <${node.name} /> stands on its own line and takes no attributes`);
  }
  return { name: node.name };
}

/** A node's source offsets; the parser sets them on every node it produces. */
function spanOf(node: RootContent, where: string): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`${where}: a parsed ${node.type} node has no source position`);
  }
  return { start, end };
}

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

/** Remark plugin for the Fumadocs MDX pipeline; source.config.ts runs it first. */
export function remarkDocsBlocks(options: { surface?: PublicSurface } = {}) {
  const surface = options.surface ?? publicSurface;
  return (tree: Root, file: { path?: string }) => {
    const where = file.path ?? "MDX page";
    const walk = (parent: Parent) => {
      parent.children = parent.children.flatMap((child) => {
        const block = blockOf(child, where);
        if (block) return parser.parse(BLOCKS[block.name](surface)).children;
        if ("children" in child) walk(child);
        return [child];
      });
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
  const { raw } = frontmatterOf(source, where);
  const tree = parser.parse(raw.replace(/[^\n]/g, " ") + source.slice(raw.length));
  const blocks: { start: number; end: number; markdown: string }[] = [];
  const [leadProvider] = publishedRampProviderIds(surface.rampProviders);
  const walk = (parent: Parent) => {
    for (const child of parent.children) {
      const block = blockOf(child, where);
      if (child.type === "code" && child.meta?.includes("rotate-providers") && leadProvider) {
        // The page rotates this fence's provider; text names the first published one.
        const span = spanOf(child, where);
        const markdown = source
          .slice(span.start, span.end)
          .replaceAll(ROTATE_PROVIDERS_TOKEN, `"${leadProvider}"`);
        blocks.push({ ...span, markdown });
      } else if (block) {
        blocks.push({ ...spanOf(child, where), markdown: BLOCKS[block.name](surface) });
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
