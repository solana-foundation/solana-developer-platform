import type { ApiMethod } from "@sdp/api-catalog/reference";
import { embedSource } from "fumadocs-core/mdx-plugins/stringifier";
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
import { apiUrl, canonicalSite } from "./site";

/**
 * Generated blocks. A page about one module carries `module:` (or
 * `rampProvider:`) frontmatter; a shared page never names a module itself and
 * instead places a block that lists what the build publishes:
 *
 * - `<ModuleTable />`: the modules, with what each does.
 * - `<ModuleCapabilities />`: one capability line per module (the AI guide).
 * - `<RampProviderMatrix />`: the ramp providers, each linking to its page.
 * - `<ApiKeyGrantsTable />`: the actions an API key can be granted, by module.
 * - `<RateLimitTable />`: the API's rate limits, per API key tier and without a key.
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
  RateLimitTable: ({ rateLimits }) =>
    table(
      ["Caller", `Requests per ${windowLabel(rateLimits.windowSeconds)}`],
      [
        ...Object.entries(rateLimits.apiKeyTiers).map(([tier, requests]) => [
          `An API key on the \`${tier}\` tier`,
          requests.toLocaleString("en-US"),
        ]),
        ["No API key, per IP address", rateLimits.unauthenticatedPerIp.toLocaleString("en-US")],
      ]
    ),
} satisfies Record<string, (surface: PublicSurface) => string>;

/** A rate limit window's length as a table heading reads it: `minute`, or `30 seconds`. */
function windowLabel(seconds: number): string {
  return seconds === 60 ? "minute" : `${seconds} seconds`;
}

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
// this file without a TypeScript resolver, so workspace packages are imported for types only:
// Node cannot follow their extensionless imports. `@sdp/types/site` (through `./site`) has none.
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
 * Wrappers a page lays its Markdown out with. In Markdown each one goes and its content stays.
 * `<ApiOperationTable>` holds a family's table of operations: on the page each row links to its
 * operation's page, and in Markdown to that page's `.md`, so an agent reading a family reads on
 * in Markdown. The others only lay a page out: `<ActionLinks>` sets its links as chips, and
 * `<ApiOperation>` an operation's body beside its `<ApiPanel>` of samples.
 */
const WRAPPERS = {
  ApiOperationTable: "links",
  ActionLinks: "layout",
  ApiOperation: "layout",
  ApiPanel: "layout",
} as const satisfies Record<string, "links" | "layout">;

type Wrapper = {
  element: Extract<RootContent, { type: "mdxJsxFlowElement" }>;
  kind: (typeof WRAPPERS)[keyof typeof WRAPPERS];
};

function isWrapperName(name: string | null): name is keyof typeof WRAPPERS {
  return name !== null && Object.hasOwn(WRAPPERS, name);
}

/** The wrapper a node is, with its kind, or undefined for any other node. */
function wrapperOf(node: RootContent, where: string): Wrapper | undefined {
  if (node.type !== "mdxJsxFlowElement" || !isWrapperName(node.name)) return undefined;
  if (node.attributes.length > 0) throw new Error(`${where}: <${node.name}> takes no attributes`);
  return { element: node, kind: WRAPPERS[node.name] };
}

/** Every link inside a node, however deep. */
function linksIn(node: RootContent): Extract<RootContent, { type: "link" }>[] {
  if (node.type === "link") return [node];
  return "children" in node ? node.children.flatMap(linksIn) : [];
}

/**
 * A wrapper's Markdown, as edits to its source: its tags go, and in a `links` wrapper each link
 * gains `.md`. The caller walks its content like the page's own.
 */
function unwrap(
  { element, kind }: Wrapper,
  source: string,
  where: string
): { start: number; end: number; markdown: string }[] {
  const span = spanOf(element, where);
  const [first] = element.children;
  const last = element.children.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(`${where}: <${element.name}> holds nothing`);
  }
  const tags = [
    { start: span.start, end: spanOf(first, where).start, markdown: "" },
    { start: spanOf(last, where).end, end: span.end, markdown: "" },
  ];
  if (kind === "layout") return tags;
  const links = element.children.flatMap(linksIn).map((link) => {
    // Each row links an operation's page inline: `[Summary](/docs/...)`.
    const linkSpan = spanOf(link, where);
    const text = source.slice(linkSpan.start, linkSpan.end);
    const target = `](${link.url})`;
    if (!/^\/docs\/[^#?]+$/.test(link.url) || !text.endsWith(target)) {
      throw new Error(`${where}: <${element.name}> links ${text}, not a docs page inline`);
    }
    return { ...linkSpan, markdown: `${text.slice(0, -target.length)}](${link.url}.md)` };
  });
  return [...tags, ...links];
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

/**
 * Remark plugin for the Fumadocs MDX pipeline; source.config.ts runs it first. On a generated
 * reference page it also sets a field's facts apart and points the code at this deployment's API
 * (`apiUrl`, from `NEXT_PUBLIC_SDP_API_URL`), where the Markdown keeps the canonical one.
 */
export function remarkDocsBlocks(options: { surface?: PublicSurface } = {}) {
  const surface = options.surface ?? publicSurface;
  return (tree: Root, file: Parameters<typeof embedSource>[0]) => {
    const where = file.path ?? "MDX page";
    const referencePage = REFERENCE_PAGE.test(where);
    const walk = (parent: Parent) => {
      parent.children = parent.children.flatMap((child) => {
        const block = blockOf(child, where);
        if (block) {
          // Fumadocs' search slices each node's Markdown from the page's source by position; the
          // block's nodes are positioned in its own Markdown, so that source is embedded.
          const markdown = BLOCKS[block.name](surface);
          const content = parser.parse(markdown).children;
          embedSource(file, child, markdown, content);
          return content;
        }
        const elementText = elementTextOf(child, where);
        if (elementText !== undefined) {
          // Fumadocs' search (remark-structure) indexes `structuredData` in place of the element.
          child.data = {
            ...child.data,
            structuredData: { contents: [{ heading: undefined, content: elementText }] },
          };
          return [child];
        }
        if (referencePage && child.type === "text" && child.value.includes(FACT_SEPARATOR)) {
          return spacedFacts(child.value);
        }
        if (referencePage && child.type === "code") {
          child.value = child.value.replaceAll(canonicalSite.apiUrl, apiUrl);
          return [child];
        }
        if ("children" in child) walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}

/** What separates a field's facts on a generated reference page (scripts/lib/api-reference-page.ts). */
const FACT_SEPARATOR = " · ";

/** The generated API reference's pages. */
const REFERENCE_PAGE = /[\\/]content[\\/]docs[\\/]reference[\\/]api[\\/]/;

/**
 * Text with its fact separators as spans, so the page can give the dots room (globals.css). The
 * Markdown agents get keeps ` · `.
 */
function spacedFacts(value: string): RootContent[] {
  return value.split(FACT_SEPARATOR).flatMap((part, index): RootContent[] => {
    const text: RootContent[] = part === "" ? [] : [{ type: "text", value: part }];
    if (index === 0) return text;
    return [
      { type: "text", value: " " },
      {
        type: "mdxJsxTextElement",
        name: "span",
        attributes: [{ type: "mdxJsxAttribute", name: "className", value: "launch-api-separator" }],
        children: [{ type: "text", value: "·" }],
      },
      { type: "text", value: " " },
      ...text,
    ];
  });
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
        // Its content is the page's own Markdown, with its own components and wrappers.
        blocks.push(...unwrap(wrapper, source, where));
        walk(wrapper.element);
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
