import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { designTokens, THEMED_GROUPS, tailwindThemeScales } from "./index";

const read = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom properties declared per selector; tokens.css has no nesting, so a flat scan is exact. */
function declarationsBySelector(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.trim();
    const declarations = blocks.get(key) ?? new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(name, value.trim());
    }
    blocks.set(key, declarations);
  }
  return blocks;
}

const tokens = declarationsBySelector(read("./tokens.css"));
const light = tokens.get(":root") ?? new Map();
const dark = tokens.get(":root.dark") ?? new Map();
const refresh = tokens.get('[data-sdp-theme="refresh"]') ?? new Map();
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
