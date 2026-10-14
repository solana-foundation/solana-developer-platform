import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs, frontmatterSchema } from "fumadocs-mdx/config";
import { remarkDocsBlocks } from "./src/lib/docs-blocks";
import { publishedRampProviderIds, ROTATE_PROVIDERS_TOKEN } from "./src/lib/docs-catalog";
import { publicSurface } from "./src/lib/release-channel";

type ShikiTransformer = NonNullable<typeof rehypeCodeDefaultOptions.transformers>[number];
type Element = Parameters<NonNullable<ShikiTransformer["span"]>>[0];
type ElementContent = Element["children"][number];

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.passthrough(),
  },
});

type Rotation = { flag: string; token: string; prefix: string; values: readonly string[] };

/**
 * Each rotation swaps `token` in fences tagged with `flag` for a carousel of
 * `values`, with `prefix` re-emitted as plain text before the carousel (so a
 * leading `/` can sit outside the chip). A list of n values animates with the
 * `rpr-track-<n>` keyframes in ramp-rotator.css, so a new length needs its own;
 * a single value replaces the token without a carousel.
 */
const ROTATIONS = [
  {
    flag: "rotate-providers",
    token: ROTATE_PROVIDERS_TOKEN,
    prefix: "",
    // Only the ramp providers this build's release channel publishes rotate.
    values: publishedRampProviderIds(publicSurface.rampProviders).map(
      (provider) => `"${provider}"`
    ),
  },
  {
    flag: "rotate-token-ops",
    token: "/freeze",
    prefix: "/",
    values: ["freeze", "unfreeze", "pause", "seize", "force-burn", "mint", "burn"],
  },
] as const satisfies readonly Rotation[];

/**
 * Builds one carousel row. The lead row carries the value as real text (so
 * copy/paste and screen readers see exactly one value); looping rows render
 * their value via CSS `content: attr(data-name)` so they never pollute the
 * copied code.
 */
function rotatorItem(value: string, lead: boolean): Element {
  if (lead) {
    return {
      type: "element",
      tagName: "span",
      properties: { className: ["rpr-item"] },
      children: [{ type: "text", value }],
    };
  }

  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["rpr-item"],
      "data-name": value,
      "aria-hidden": "true",
    },
    children: [],
  };
}

/**
 * Replaces a rotation's token in fences tagged with its flag with a vertical
 * carousel cycling through the rotation's values (see ROTATIONS).
 */
const rampProviderRotator: ShikiTransformer = {
  name: "ramp-provider-rotator",
  span(node) {
    const meta = this.options.meta?.__raw;
    if (!meta) return;
    const rotation = ROTATIONS.find((candidate) => meta.includes(candidate.flag));
    if (!rotation) return;
    if (node.children.length !== 1) return;
    const child = node.children[0];
    if (child.type !== "text" || !child.value.includes(rotation.token)) return;

    const [before, after] = child.value.split(rotation.token);
    const [leadValue, ...restValues] = rotation.values;
    if (leadValue === undefined) return;
    if (restValues.length === 0) {
      child.value = before + rotation.prefix + leadValue + after;
      return;
    }
    const items: ElementContent[] = [
      rotatorItem(leadValue, true),
      ...restValues.map((value) => rotatorItem(value, false)),
      rotatorItem(leadValue, false),
    ];

    node.children = [
      { type: "text", value: before + rotation.prefix },
      {
        type: "element",
        tagName: "span",
        properties: { className: ["rpr"] },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["rpr-track", `rpr-track-${rotation.values.length}`] },
            children: items,
          },
        ],
      },
      { type: "text", value: after },
    ];
  },
};

const defaultTransformers = rehypeCodeDefaultOptions.transformers;
if (!defaultTransformers) {
  throw new Error("fumadocs rehype-code default transformers missing");
}

export default defineConfig({
  mdxOptions: {
    // Generated blocks first, so headings and search text see what the build
    // publishes (src/lib/docs-blocks.ts).
    remarkPlugins: (defaults) => [remarkDocsBlocks, ...defaults],
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [...defaultTransformers, rampProviderRotator],
    },
  },
});
