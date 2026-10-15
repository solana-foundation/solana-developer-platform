import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findValueMovementViolations } from "./check-value-movement.mjs";

function fixture(files) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "value-movement-"));
  writeFileSync(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    })
  );
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(rootDir, file)), { recursive: true });
    writeFileSync(path.join(rootDir, file), contents);
  }
  return rootDir;
}

const CAPABILITY = {
  id: "admit",
  why: "test capability",
  symbols: [{ file: "src/lib/cap.ts", name: "mint" }],
  owners: ["src/lib/cap.ts"],
  allow: ["src/allowed.ts"],
};

const CAP_SOURCE = `export function mint(): number { return 1; }
export class Signer {
  static create(): Signer { return new Signer(); }
  sign(): void {}
}
`;

function violations(files, capabilities = [CAPABILITY]) {
  const rootDir = fixture({ "src/lib/cap.ts": CAP_SOURCE, ...files });
  try {
    return findValueMovementViolations({
      rootDir,
      tsconfig: path.join(rootDir, "tsconfig.json"),
      capabilities,
      scanRoots: ["src/"],
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("allows an allowlisted file and flags everything else, however it is imported", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/renamed.ts": `import { mint as m } from "./lib/cap";\nm();\n`,
    "src/namespace.ts": `import * as cap from "./lib/cap";\ncap.mint();\n`,
    "src/reexport.ts": `export { mint } from "./lib/cap";\n`,
    "src/via-reexport.ts": `import { mint } from "./reexport";\nmint();\n`,
  });

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual(
    [...flagged].sort(),
    ["src/namespace.ts", "src/reexport.ts", "src/renamed.ts", "src/via-reexport.ts"].sort()
  );
});

test("fails a stale allowlist entry, so shrink-only lists cannot grow back silently", () => {
  const found = violations({ "src/allowed.ts": "export const unrelated = 1;\n" });

  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/allowed\.ts: no longer references admit/);
});

test("lets tests reference capabilities", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/lib/cap.test.ts": `import { mint } from "./cap";\nmint();\n`,
  });

  assert.deepEqual(found, []);
});

test("flags destructuring, element access and whole-module escapes", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/destructure.ts": `import * as cap from "./lib/cap";\nconst { mint } = cap;\nmint();\n`,
    "src/element.ts": `import * as cap from "./lib/cap";\ncap["mint"]();\n`,
    "src/dynamic.ts": `export async function load() {\n  return import("./lib/cap");\n}\n`,
    "src/star.ts": `export * from "./lib/cap";\n`,
    "src/star-as.ts": `export * as cap from "./lib/cap";\n`,
  });

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual(
    [...flagged].sort(),
    [
      "src/destructure.ts",
      "src/dynamic.ts",
      "src/element.ts",
      "src/star-as.ts",
      "src/star.ts",
    ].sort()
  );
});

test("exempts only test files, not a production module under a test-named directory", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/feature/test/helper.ts": `import { mint } from "../../lib/cap";\nmint();\n`,
  });

  assert.ok(found.length > 0);
  for (const violation of found) {
    assert.match(violation, /^src\/feature\/test\/helper\.ts:/);
  }
});

test("flags a whole-module import of a barrel that only re-exports a capability", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/lib/barrel.ts": `export { mint } from "./cap";\n`,
    "src/barrel-user.ts": `export async function load() {\n  return import("./lib/barrel");\n}\n`,
  });

  assert.ok(found.some((violation) => violation.startsWith("src/barrel-user.ts:")));
});

test("checks every capability a whole module carries, not just the first", () => {
  const second = {
    id: "second",
    why: "second capability",
    symbols: [{ file: "src/lib/cap.ts", name: "Signer" }],
    owners: ["src/lib/cap.ts"],
    allow: [],
  };
  const first = { ...CAPABILITY, symbols: [{ file: "src/lib/cap.ts", name: "mint" }] };
  const found = violations(
    {
      "src/allowed.ts": `import * as cap from "./lib/cap";\ncap.mint();\n`,
    },
    [first, second]
  );

  assert.ok(found.some((violation) => /src\/allowed\.ts:1: references second/.test(violation)));
});

test("lets an allowlisted file call a capability but not hand it out under another name", () => {
  const SIGNER = {
    id: "signer",
    why: "signer capability",
    symbols: [{ file: "src/lib/cap.ts", name: "Signer" }],
    owners: ["src/lib/cap.ts"],
    allow: ["src/allowed.ts"],
  };
  const uses = violations(
    {
      "src/allowed.ts": `import { mint } from "./lib/cap";
import { Signer } from "./lib/cap";
export { Signer as Renamed } from "./lib/cap";
mint();
(mint as () => number)();
const signer: Signer = new Signer();
signer.sign();
Signer.create();
`,
    },
    [CAPABILITY, SIGNER]
  );
  assert.deepEqual(uses, []);

  const escapes = violations(
    {
      "src/allowed.ts": `import { mint, Signer } from "./lib/cap";
mint();
export const Direct = Signer;
export const table = { privy: Signer };
export class Sub extends Signer {}
export function give() { return mint; }
register(Signer);
export const bound = mint.bind(null);
declare function register(value: unknown): void;
`,
      "src/user.ts": `import { Direct } from "./allowed";\nnew Direct();\n`,
    },
    [CAPABILITY, SIGNER]
  );
  const lines = escapes.map((violation) => violation.split(": ")[0]).sort();
  assert.deepEqual(lines, [
    "src/allowed.ts:3",
    "src/allowed.ts:4",
    "src/allowed.ts:5",
    "src/allowed.ts:6",
    "src/allowed.ts:7",
    "src/allowed.ts:8",
  ]);
});

test("pins a package constructor however a re-exporting package spells it", () => {
  const KEYPAIR = {
    id: "keypair",
    why: "keypair capability",
    symbols: [{ module: "kit", name: "fromBytes" }],
    owners: [],
    allow: ["src/allowed.ts"],
  };
  const found = violations(
    {
      "node_modules/signers/package.json": JSON.stringify({ name: "signers", types: "index.d.ts" }),
      "node_modules/signers/index.d.ts":
        "export declare function fromBytes(bytes: Uint8Array): unknown;\n",
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", types: "index.d.ts" }),
      "node_modules/kit/index.d.ts": 'export * from "signers";\n',
      "src/allowed.ts": `import { fromBytes } from "signers";\nfromBytes(new Uint8Array());\n`,
      "src/direct.ts": `import { fromBytes } from "kit";\nfromBytes(new Uint8Array());\n`,
    },
    [KEYPAIR]
  );

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual([...flagged], ["src/direct.ts"]);
});

test("pins every callable a whole module exports, but not its constants", () => {
  const PROVIDER = {
    id: "provider",
    why: "provider capability",
    symbols: [{ file: "src/lib/provider.ts", name: "*" }],
    owners: ["src/lib/provider.ts"],
    allow: [],
  };
  const found = violations(
    {
      "src/lib/provider.ts": `export class Signer {}
export function client(): number { return 1; }
export const LABEL = "provider";
export type Config = { id: string };
`,
      "src/signer.ts": `import { Signer } from "./lib/provider";\nnew Signer();\n`,
      "src/client.ts": `import { client } from "./lib/provider";\nclient();\n`,
      "src/label.ts": `import { LABEL, type Config } from "./lib/provider";\nexport const c: Config = { id: LABEL };\n`,
    },
    [PROVIDER]
  );

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual([...flagged].sort(), ["src/client.ts", "src/signer.ts"]);
});

test("refuses code the checker cannot follow", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/computed.ts": `export const load = (name: string) => import(name);\n`,
    "src/evaluated.ts": `export const run = (code: string) => eval(code);\n`,
    "src/constructed.ts": `export const make = (code: string) => new Function(code);\n`,
  });

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual(
    [...flagged].sort(),
    ["src/computed.ts", "src/constructed.ts", "src/evaluated.ts"].sort()
  );
});

test("refuses a code loader however it is renamed or reached, but not a member of the same name", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/runtime.d.ts": `declare module "node:module" {
  export function createRequire(path: string): (id: string) => unknown;
}
declare var require: (id: string) => unknown;
`,
    "src/renamed.ts": `import { createRequire as load } from "node:module";\nexport const kit = load("x")("y");\n`,
    "src/aliased-eval.ts": `const run = eval;\nexport const out = run("1");\n`,
    "src/global-eval.ts": `export const out = globalThis["eval"]("1");\n`,
    "src/aliased-require.ts": `const req = require;\nexport const out = req("x");\n`,
    "src/literal-require.ts": `export const out = require("./lib/other");\n`,
    "src/lib/other.ts": `export const value = 1;\n`,
    "src/member.ts": `declare const client: { eval(script: string): number };\nexport const out = client.eval("return 1");\n`,
    "src/typed.ts": `export const call = (fn: Function) => fn;\n`,
    "src/type-import.ts": `import type { createRequire } from "node:module";\nexport type Loader = typeof createRequire;\n`,
    "src/type-specifier.ts": `import { type createRequire as Load } from "node:module";\nexport type Loader = typeof Load;\n`,
  });

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual(
    [...flagged].sort(),
    ["src/aliased-eval.ts", "src/aliased-require.ts", "src/global-eval.ts", "src/renamed.ts"].sort()
  );
});

test("lets a defining package use its own constructors and checks every other one", () => {
  const PACKAGE = {
    id: "package",
    why: "package capability",
    symbols: [{ file: "src/pkg/adapter.ts", name: "Adapter" }],
    owners: ["src/pkg/"],
    allow: [],
  };
  const found = violations(
    {
      "src/pkg/adapter.ts": `export class Adapter {}\n`,
      "src/pkg/sub.ts": `import { Adapter } from "./adapter";\nexport class Sub extends Adapter {}\nexport const make = () => new Adapter();\n`,
      "src/other/uses.ts": `import { Adapter } from "../pkg/adapter";\nnew Adapter();\n`,
    },
    [PACKAGE]
  );

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual([...flagged], ["src/other/uses.ts"]);
});

test("lets an allowlisted file call through a namespace but not hand the namespace out", () => {
  const found = violations({
    "src/allowed.ts": `import * as ns from "./lib/cap";
ns.mint();
ns["mint"]();
export * from "./lib/cap";
export * as direct from "./lib/cap";
export const leak = ns;
declare const name: "mint";
ns[name]();
`,
    "src/user.ts": `import { direct } from "./allowed";\nconst name = "mint" as const;\ndirect[name]();\n`,
  });

  const lines = found.map((violation) => violation.split(": ")[0]).sort();
  assert.deepEqual(lines, ["src/allowed.ts:5", "src/allowed.ts:6", "src/allowed.ts:8"]);
});
