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

const PALETTE_SCOPE = '[data-sdp-theme="refresh"], :root:has([data-sdp-palette="refresh"])';
const SHAPE_SCOPE = '[data-sdp-theme="refresh"]';
// Component shapes the refresh design changes; pages outside a refresh subtree keep their own.
const SHAPE_TOKEN = /^--(button-radius|input-|tab-|table-|select-|tooltip-|text-button)/;

describe("sdp-theme.css", () => {
  const blocks = declarationsBySelector();

  it("gives the whole document the refresh text and button colours under NEW DESIGN", () => {
    expect(blocks.get(PALETTE_SCOPE)).toEqual(
      expect.arrayContaining(["--text-extra-high", "--button-primary-bg", "--border-light"])
    );
  });

  it("keeps every component shape on the refresh subtree alone", () => {
    const leaked = [...blocks]
      .filter(([selector]) => selector !== SHAPE_SCOPE && !selector.startsWith(`${SHAPE_SCOPE} `))
      .flatMap(([selector, names]) =>
        names.filter((name) => SHAPE_TOKEN.test(name)).map((name) => `${selector} ${name}`)
      );
    expect(leaked).toEqual([]);
    expect(blocks.get(SHAPE_SCOPE)).toEqual(
      expect.arrayContaining(["--button-radius-xl", "--input-radius-xl", "--table-radius"])
    );
  });
});
