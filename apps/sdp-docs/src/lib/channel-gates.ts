import type { Nodes, Parent, Root, TableRow } from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  type ChannelGate,
  checkGate,
  frontmatterOf,
  isGatePublished,
  type PublicSurface,
  publicSurface,
} from "./release-channel";

/**
 * Release-channel gates inside a page, resolved before anything reads the page:
 *
 * - `<InChannel module="ramps">…</InChannel>` (block or inline) keeps its
 *   children only when the build publishes the module; `rampProvider="moonpay"`
 *   gates on one ramp provider.
 * - `<ChannelRow module="issuance" />` anywhere in a table row keeps the row only
 *   when the build publishes the module (Markdown table rows cannot be wrapped).
 *
 * `remarkChannelGates` applies them to the MDX tree before Fumadocs extracts
 * headings (the table of contents) and search text, so hidden content never
 * reaches either. `resolveChannelGates` applies the same decisions to raw MDX
 * text for the llms files, the Markdown route and the link checker. Both parse
 * with the same micromark extensions, so the two cannot disagree.
 */

type GateElement = MdxJsxFlowElement | MdxJsxTextElement;

const GATE_NAMES = new Set(["InChannel", "ChannelRow"]);

function isGateElement(node: Nodes): node is GateElement {
  return (
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    node.name !== null &&
    GATE_NAMES.has(node.name)
  );
}

/** The element's gate. Attributes must be one literal `module` or `rampProvider`. */
function gateOf(node: GateElement, where: string): ChannelGate {
  const attributes = node.attributes.map((attribute) => {
    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") {
      throw new Error(
        `${where}: <${node.name}> takes one literal module or rampProvider attribute`
      );
    }
    return [attribute.name, attribute.value] as const;
  });
  const [only] = attributes;
  if (attributes.length !== 1 || !only || !["module", "rampProvider"].includes(only[0])) {
    throw new Error(`${where}: <${node.name}> takes one literal module or rampProvider attribute`);
  }
  const gate: ChannelGate = only[0] === "module" ? { module: only[1] } : { rampProvider: only[1] };
  return checkGate(gate, `${where} <${node.name}>`);
}

/** The `<ChannelRow>` markers in a table row, each with the node that holds it. */
function rowMarkers(row: TableRow): { marker: GateElement; parent: Parent }[] {
  const markers: { marker: GateElement; parent: Parent }[] = [];
  const visit = (node: Parent) => {
    for (const child of node.children as Nodes[]) {
      if (isGateElement(child) && child.name === "ChannelRow")
        markers.push({ marker: child, parent: node });
      else if ("children" in child) visit(child);
    }
  };
  visit(row);
  return markers;
}

type Edit = { start: number; end: number };

type GateVisitor = {
  onRemove: (node: Nodes, parent: Parent) => void;
  onUnwrap: (node: GateElement, parent: Parent) => void;
};

/**
 * Walks a tree, deciding every gate. `onRemove` gets each node to drop (a gated
 * element or table row the build does not publish); `onUnwrap` each published
 * element (keep its children, drop its tags) or row marker (drop it).
 */
function decideGates(tree: Root, where: string, surface: PublicSurface, visitor: GateVisitor) {
  const decideRow = (row: TableRow, parent: Parent) => {
    const markers = rowMarkers(row);
    const gates = markers.map(({ marker }) => gateOf(marker, where));
    if (gates.some((gate) => !isGatePublished(gate, surface))) {
      visitor.onRemove(row, parent);
      return;
    }
    for (const { marker, parent: holder } of markers) visitor.onUnwrap(marker, holder);
    walk(row, true);
  };

  const decideElement = (element: GateElement, parent: Parent, inRow: boolean) => {
    if (element.name === "ChannelRow") {
      // Decided with its row.
      if (inRow) return;
      throw new Error(`${where}: <ChannelRow> belongs in a table row`);
    }
    if (!isGatePublished(gateOf(element, where), surface)) {
      visitor.onRemove(element, parent);
      return;
    }
    walk(element, inRow);
    visitor.onUnwrap(element, parent);
  };

  function walk(parent: Parent, inRow = false): void {
    for (const child of [...parent.children] as Nodes[]) {
      if (child.type === "tableRow") decideRow(child, parent);
      else if (isGateElement(child)) decideElement(child, parent, inRow);
      else if ("children" in child) walk(child, inRow);
    }
  }

  walk(tree);
}

/**
 * Remark plugin for the Fumadocs MDX pipeline. Must run before remark-heading
 * and remark-structure (source.config.ts puts it first).
 */
export function remarkChannelGates(options: { surface?: PublicSurface } = {}) {
  const surface = options.surface ?? publicSurface;
  return (tree: Root, file: { path?: string }) => {
    decideGates(tree, file.path ?? "MDX page", surface, {
      onRemove: (node, parent) => {
        parent.children.splice(parent.children.indexOf(node as never), 1);
      },
      onUnwrap: (node, parent) => {
        const index = parent.children.indexOf(node as never);
        parent.children.splice(index, 1, ...(node.name === "ChannelRow" ? [] : node.children));
      },
    });
  };
}

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

/**
 * Applies a page's gates to its raw MDX text, keeping everything else byte for
 * byte. With `preserveLines`, removed text keeps its line breaks so line numbers
 * after it still match the source file (the link checker reports them).
 */
export function resolveChannelGates(
  source: string,
  where: string,
  options: { preserveLines?: boolean; surface?: PublicSurface } = {}
): string {
  // Frontmatter is not MDX; blank it (keeping offsets) for the parse.
  const { raw } = frontmatterOf(source);
  const body = raw.replace(/[^\n]/g, " ") + source.slice(raw.length);
  const tree = parser.parse(body) as Root;
  const edits: Edit[] = [];
  const span = (node: Nodes): Edit => ({
    start: node.position?.start.offset ?? 0,
    end: node.position?.end.offset ?? 0,
  });

  decideGates(tree, where, options.surface ?? publicSurface, {
    onRemove: (node) => {
      const edit = span(node);
      // A removed table row takes its line break with it.
      if (node.type === "tableRow" && source[edit.end] === "\n") edit.end += 1;
      edits.push(edit);
    },
    onUnwrap: (node) => {
      const whole = span(node);
      const first = node.children[0];
      const last = node.children.at(-1);
      if (node.name === "ChannelRow" || !first || !last) {
        if (source[whole.start - 1] === " ") whole.start -= 1;
        edits.push(whole);
        return;
      }
      edits.push({ start: whole.start, end: span(first).start });
      edits.push({ start: span(last).end, end: whole.end });
    },
  });

  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    const removed = result.slice(edit.start, edit.end);
    const replacement = options.preserveLines ? removed.replace(/[^\n]/g, "") : "";
    result = result.slice(0, edit.start) + replacement + result.slice(edit.end);
  }
  return result;
}
