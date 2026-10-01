import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { designTokens, THEMED_GROUPS, tailwindThemeScales } from "./index";

const read = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Block = { selectors: string[]; declarations: Map<string, string> };

/** Rule blocks in source order; tokens.css has no nesting, so a flat scan is exact. */
function parseBlocks(css: string): Block[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(",").map((part) => part.trim()),
    declarations: new Map(
      [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
        name,
        value.trim(),
      ])
    ),
  }));
}

/** Custom properties declared per selector, merged across blocks that share it. */
function declarationsBySelector(blocks: Block[]): Map<string, Map<string, string>> {
  const bySelector = new Map<string, Map<string, string>>();
  for (const { selectors, declarations } of blocks) {
    for (const selector of selectors) {
      const merged = bySelector.get(selector) ?? new Map<string, string>();
      for (const [name, value] of declarations) merged.set(name, value);
      bySelector.set(selector, merged);
    }
  }
  return bySelector;
}

/** Class-level specificity of the compound selectors tokens.css uses (no ids or elements). */
const specificity = (selector: string) =>
  selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)?.length ?? 0;

/** A selector that applies to <html class="dark" data-sdp-theme="refresh">. */
const matchesRefreshRoot = (selector: string) =>
  selector !== "" && /^(:root)?(\.dark|\[data-sdp-theme="refresh"\])*$/.test(selector);

function selectorBlock(selector: string): Map<string, string> {
  const block = tokens.get(selector);
  assert.ok(block, `tokens.css has no ${selector} block`);
  return block;
}

const REFRESH_SCOPE = '[data-sdp-theme="refresh"]';
const blocks = parseBlocks(read("./tokens.css"));
const tokens = declarationsBySelector(blocks);
const light = selectorBlock(":root");
const dark = selectorBlock(":root.dark");
const refresh = selectorBlock(REFRESH_SCOPE);
const catalog = new Map(designTokens.map((token) => [token.name, token]));

describe("design token catalog", () => {
  it("names each token once", () => {
    assert.equal(catalog.size, designTokens.length);
  });

  it("declares every catalogued token for light mode", () => {
    const missing = designTokens.filter((token) => !light.has(token.name)).map((t) => t.name);
    assert.deepEqual(missing, []);
  });

  it("catalogues every token tokens.css declares", () => {
    const declared = [...light.keys(), ...dark.keys()];
    const undocumented = [...new Set(declared)].filter((name) => !catalog.has(name as never));
    assert.deepEqual(undocumented, []);
  });

  it("gives every themed token a dark value and nothing else one", () => {
    const themed = designTokens.filter((token) => THEMED_GROUPS.includes(token.group));
    assert.deepEqual(
      themed.filter((token) => !dark.has(token.name)).map((t) => t.name),
      []
    );
    const unthemedInDark = [...dark.keys()].filter(
      (name) => !THEMED_GROUPS.includes(catalog.get(name as never)?.group as never)
    );
    assert.deepEqual(unthemedInDark, []);
  });

  it("lets the refresh scope win on <html>, in light and dark", () => {
    // The scope can sit on <html>, which also carries .dark, so for every base name it
    // re-points, its strongest :root selector must beat or tie-and-follow each earlier rule.
    const scopeIndex = blocks.findIndex((block) => block.selectors.includes(REFRESH_SCOPE));
    const scope = blocks[scopeIndex];
    const scopeSpecificity = Math.max(
      ...scope.selectors.filter(matchesRefreshRoot).map(specificity)
    );
    blocks.forEach((block, index) => {
      if (index === scopeIndex) return;
      for (const selector of block.selectors.filter(matchesRefreshRoot)) {
        const overlap = [...block.declarations.keys()].filter((name) => refresh.has(name));
        if (overlap.length === 0) continue;
        const wins =
          specificity(selector) < scopeSpecificity ||
          (specificity(selector) === scopeSpecificity && index < scopeIndex);
        assert.ok(wins, `${selector} overrides the refresh scope on <html> for ${overlap[0]}`);
      }
    });
  });

  it("only re-points base tokens inside the refresh scope, and only at declared tokens", () => {
    for (const [name, value] of refresh) {
      assert.ok(light.has(name), `${name} is not a base token`);
      const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
      assert.ok(reference && light.has(reference), `${name} must point at a declared token`);
    }
  });
});

describe("tailwind theme", () => {
  const theme = read("./theme.css");

  it("references only declared tokens", () => {
    const referenced = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name);
    assert.deepEqual(
      [...new Set(referenced)].filter((name) => !light.has(name)),
      []
    );
  });

  it("maps every catalogued utility", () => {
    const themeKeys = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
    // A utility's @theme key is its namespace plus the rest of its name; text-* can be a
    // colour or a font size.
    const namespaces: Record<string, string[]> = {
      text: ["--color-", "--text-"],
      bg: ["--color-"],
      border: ["--color-"],
      rounded: ["--radius-"],
      h: ["--spacing-"],
      "max-w": ["--container-"],
      shadow: ["--shadow-"],
    };
    for (const { name, utility } of designTokens) {
      if (!utility) continue;
      const [, kind = "", key = ""] = utility.match(/^(max-w|[a-z]+)-(.+)$/) ?? [];
      const candidates = (namespaces[kind] ?? []).map((namespace) => `${namespace}${key}`);
      assert.ok(
        candidates.some((candidate) => themeKeys.has(candidate)),
        `${utility} (${name}) has no @theme entry`
      );
    }
  });

  it("lists every scale name it adds for class mergers, and only those", () => {
    const themeKeys = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
    const added = [...themeKeys].filter(
      (key) => /^--(text|radius|spacing|container)-[a-z-]+$/.test(key) && !key.includes("--", 2)
    );
    const listed = Object.entries(tailwindThemeScales).flatMap(([scale, names]) =>
      names.map((name) => `--${scale}-${name}`)
    );
    assert.deepEqual([...listed].sort(), [...added].sort());
  });
});
