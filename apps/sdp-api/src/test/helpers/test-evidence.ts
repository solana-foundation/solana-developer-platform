/**
 * Evidence helpers for inventory gates that pin behavior to a named test
 * (see `wallet-scope-route-inventory.test.ts` and
 * `security/value-moving-conformance.node.test.ts`). A disabled test is no
 * evidence, so gates resolve their named test through these helpers instead
 * of matching a bare substring anywhere in a file.
 */

/** A test's body: from its title to the next test or describe. */
export function testBlock(source: string, title: string): string | null {
  const start = source.indexOf(title);
  if (start === -1) return null;
  const rest = source.slice(start + title.length);
  const next = rest.search(/\n\s*(it|test|describe)(\.each)?[(<]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Whether the test titled `title` would not run: its own declaration is
 * `skip`, `todo` or `x`-prefixed, or the file skips a describe (which may
 * enclose it). A disabled test is no evidence.
 */
export function isDisabledTest(source: string, title: string): boolean {
  const start = source.indexOf(title);
  if (start === -1) return false;
  if (/\b(?:xdescribe|describe(?:\.\w+)*\.(?:skip|todo))\s*[(<]/.test(source)) return true;
  const declarations = [
    ...source.slice(0, start).matchAll(/\b(x?)(?:it|test)((?:\.\w+)*)\s*[(<]/g),
  ];
  const own = declarations.at(-1);
  return own !== undefined && (own[1] === "x" || /\.(?:skip|todo)\b/.test(own[2] ?? ""));
}
