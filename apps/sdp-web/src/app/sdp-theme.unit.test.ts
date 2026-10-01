import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./sdp-theme.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/** Custom properties declared per selector, for the file's flat (unnested) blocks. */
function declarationsBySelector(): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.trim().replace(/\s+/g, " ");
    const names = [...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name);
    blocks.set(key, [...(blocks.get(key) ?? []), ...names]);
  }
  return blocks;
}

const PALETTE_SCOPE = ":root:has(main[data-sdp-new-design])";
const SHAPE_SCOPE = '[data-sdp-theme="refresh"]';
// Component shapes the refresh design changes. Under NEW DESIGN every page takes the palette, but
// only a refresh subtree takes these; pages that aren't redesigned keep their own.
const SHAPE_TOKEN = /^--(button-radius|input-|tab-|table-|select-|tooltip-|text-button)/;

describe("sdp-theme.css", () => {
  const blocks = declarationsBySelector();

  it("gives the whole document the refresh text and button colours under NEW DESIGN", () => {
    expect(blocks.get(PALETTE_SCOPE)).toEqual(
      expect.arrayContaining(["--text-extra-high", "--button-primary-bg", "--border-light"])
    );
  });

  it("keeps every component shape on the refresh subtree alone", () => {
    // A refresh rule may also name the scope on the root (`:root[data-sdp-theme="refresh"]`) so it
    // outranks `:root.dark`; it is still refresh-only while every selector in its list is.
    const refreshOnly = (selector: string) =>
      selector
        .split(",")
        .map((part) => part.trim().replace(/^:root(?=\[)/, ""))
        .every((part) => part === SHAPE_SCOPE || part.startsWith(`${SHAPE_SCOPE} `));
    const leaked = [...blocks]
      .filter(([selector]) => !refreshOnly(selector))
      .flatMap(([selector, names]) =>
        names.filter((name) => SHAPE_TOKEN.test(name)).map((name) => `${selector} ${name}`)
      );
    expect(leaked).toEqual([]);
    const refreshShapes = [...blocks]
      .filter(([selector]) => refreshOnly(selector))
      .flatMap(([, names]) => names);
    expect(refreshShapes).toEqual(
      expect.arrayContaining(["--button-radius-xl", "--input-radius-xl", "--table-radius"])
    );
  });
});
