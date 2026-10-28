import type { ApiMethod } from "@sdp/api-catalog/reference";
import type { Parent, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";
import {
  DOCS_ACTION_MODULES,
  DOCS_MODULES,
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
 * - `<ApiKeyGrantsTable />`: the actions an API key can be granted, by module.
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
  ApiKeyGrantsTable: (surface) =>
    table(
      ["Module", "Actions", "Covers"],
      // Modules in registry order, which the manifest keeps.
      surface.grantableActions.map(({ module, verbs }) => [
        `\`${module}\``,
        verbs.map((verb) => `\`${module}.${verb}\``).join(", "),
        DOCS_ACTION_MODULES[module],
      ])
    ),
} satisfies Record<string, (surface: PublicSurface) => string>;

type BlockName = keyof typeof BLOCKS;

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

// Every API method, checked against the package's list by the compiler. source.config.ts loads
// this file without a TypeScript resolver, so workspace packages are imported for types only.
const API_METHOD_NAMES = {
  GET: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
} as const satisfies Record<ApiMethod, true>;

const apiEndpointSchema = z.strictObject({
  method: z.custom<ApiMethod>(
    (value) => typeof value === "string" && Object.hasOwn(API_METHOD_NAMES, value)
  ),
  path: z.string().startsWith("/"),
});

/**
 * Components the API reference places (scripts/lib/api-reference-page.ts). Unlike a block, the
 * page renders the component itself (mdx-components.tsx); each one's text is what
 * `expandDocsBlocks` writes, in a code span, and what search indexes.
 */
const ELEMENTS = {
  ApiEndpoint: (attributes) => {
    const { method, path } = apiEndpointSchema.parse(attributes);
    return `${method} ${path}`;
  },
} satisfies Record<string, (attributes: Record<string, string>) => string>;

type ElementName = keyof typeof ELEMENTS;

function isElementName(name: string | null): name is ElementName {
  return name !== null && Object.hasOwn(ELEMENTS, name);
}

/**
 * Wrappers the reference lays its Markdown out with: `<ApiOperationTable>` holds a family's table
 * of operations. On the page each row links to its operation's page; in Markdown the wrapper
 * goes and each link points at that page's `.md`, so an agent reading a family reads on in
 * Markdown.
 */
const WRAPPERS: ReadonlySet<string> = new Set(["ApiOperationTable"]);

/** The wrapper element a node is, or undefined for any other node. */
function wrapperOf(node: RootContent, where: string) {
  if (node.type !== "mdxJsxFlowElement" || node.name === null || !WRAPPERS.has(node.name)) {
    return undefined;
  }
  if (node.attributes.length > 0) throw new Error(`${where}: <${node.name}> takes no attributes`);
  return node;
}

/** Every link inside a node, however deep. */
function linksIn(node: RootContent): Extract<RootContent, { type: "link" }>[] {
  if (node.type === "link") return [node];
  return "children" in node ? node.children.flatMap(linksIn) : [];
}

/** A wrapper's Markdown, as edits to its source: its tags go, and each link inside gains `.md`. */
function unwrap(
  wrapper: Extract<RootContent, { type: "mdxJsxFlowElement" }>,
  source: string,
  where: string
): { start: number; end: number; markdown: string }[] {
  const span = spanOf(wrapper, where);
  const [first] = wrapper.children;
  const last = wrapper.children.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(`${where}: <${wrapper.name}> holds nothing`);
  }
  const links = wrapper.children.flatMap(linksIn).map((link) => {
    // Each row links an operation's page inline: `[Summary](/docs/...)`.
    const linkSpan = spanOf(link, where);
    const text = source.slice(linkSpan.start, linkSpan.end);
    const target = `](${link.url})`;
    if (!/^\/docs\/[^#?]+$/.test(link.url) || !text.endsWith(target)) {
      throw new Error(`${where}: <${wrapper.name}> links ${text}, not a docs page inline`);
    }
    return { ...linkSpan, markdown: `${text.slice(0, -target.length)}](${link.url}.md)` };
  });
  return [
    { start: span.start, end: spanOf(first, where).start, markdown: "" },
    ...links,
    { start: spanOf(last, where).end, end: span.end, markdown: "" },
  ];
}

/** A reference component's text, or undefined for any other node. */
function elementTextOf(node: RootContent, where: string): string | undefined {
  if (node.type !== "mdxJsxFlowElement" || !isElementName(node.name)) return undefined;
  const attributes: Record<string, string> = {};
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") {
      throw new Error(`${where}: <${node.name} /> takes string attributes only`);
    }
    attributes[attribute.name] = attribute.value;
  }
  if (node.children.length > 0) throw new Error(`${where}: <${node.name} /> takes no children`);
  return ELEMENTS[node.name](attributes);
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
        const elementText = elementTextOf(child, where);
        if (elementText !== undefined) {
          // Fumadocs' search (remark-structure) indexes `_stringify.text` for the element.
          child.data = { ...child.data, _stringify: { text: elementText } };
          return [child];
        }
        if ("children" in child) walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/**
 * Markdown without the page's ESM `import` and `export` statements, for the Markdown route and
 * the llms files. The parser finds them, so a line in a code fence that starts with `import` (a
 * Python sample's `import os, requests`) stays.
 */
export function stripMdxEsm(markdown: string, where: string): string {
  const statements = parser
    .parse(markdown)
    .children.filter((node) => node.type === "mdxjsEsm")
    .map((node) => spanOf(node, where));
  let result = markdown;
  for (const span of statements.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result;
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
      const elementText = elementTextOf(child, where);
      const wrapper = wrapperOf(child, where);
      if (child.type === "code" && child.meta?.includes("rotate-providers") && leadProvider) {
        // The page rotates this fence's provider; text names the first published one.
        const span = spanOf(child, where);
        const markdown = source
          .slice(span.start, span.end)
          .replaceAll(ROTATE_PROVIDERS_TOKEN, `"${leadProvider}"`);
        blocks.push({ ...span, markdown });
      } else if (block) {
        blocks.push({ ...spanOf(child, where), markdown: BLOCKS[block.name](surface) });
      } else if (elementText !== undefined) {
        blocks.push({ ...spanOf(child, where), markdown: `\`${elementText}\`` });
      } else if (wrapper !== undefined) {
        blocks.push(...unwrap(wrapper, source, where));
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
