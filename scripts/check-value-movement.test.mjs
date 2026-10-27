import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findBrandedCastViolations,
  findTokenMovementBuilderViolations,
  findValueMovementViolations,
} from "./check-value-movement.mjs";

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

const BRANDED_SOURCE = `declare const brand: unique symbol;
export type Units = bigint & { readonly [brand]: true };
export type Intent = { readonly amount: Units };
export function units(value: bigint): Units {
  return value as Units;
}
`;

const BRANDED_TYPES = [
  { file: "src/lib/units.ts", name: "Units" },
  { file: "src/lib/units.ts", name: "Intent" },
];

function castViolations(files, tsconfigs = ["tsconfig.json"]) {
  const rootDir = fixture({ "src/lib/units.ts": BRANDED_SOURCE, ...files });
  try {
    return findBrandedCastViolations({
      rootDir,
      tsconfigs: tsconfigs.map((tsconfig) => path.join(rootDir, tsconfig)),
      brandedTypes: BRANDED_TYPES,
      scanRoots: ["src/", "web/"],
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("flags every assertion to a branded type outside its module, however it is spelled", () => {
  const found = castViolations({
    "src/casts.ts": `import type { Intent, Units } from "./lib/units";
import type { Units as Renamed } from "./lib/units";
type Local = Units;
declare const raw: bigint;
declare const sample: Units;
export const a = raw as Units;
export const b = raw as unknown as Units;
export const c = <Units>raw;
export const d = raw as Renamed;
export const e = raw as Local;
export const f = [] as Units[];
export const g = {} as { amount: Units };
export const h = {} as Intent;
export const i = raw as typeof sample;
interface Forged extends Intent {}
interface Holder { amount: Units }
interface Deeper extends Holder {}
class Minted implements Intent { readonly amount = 1n; }
class Spender { spend(): bigint { const local: Units = 1n as never; return local; } }
export const j = {} as Forged;
export const k = {} as Holder;
export const l = {} as Deeper;
export const m = {} as Minted;
export const n = {} as Spender;
declare function make(): Units;
declare function take(amount: Units): void;
export const o: Units = raw as never;
export const p: { amount?: Units } = { amount: raw as any };
take(raw as never);
export const q = raw as ReturnType<typeof make>;
export const r = raw as Parameters<typeof take>[0];
export const s: bigint = raw as never;
export const t = [raw] as never[];
declare function takeAll(amounts: Units[]): void;
takeAll([{}] as never);
export const u: Units[] = [{}] as never;
export const v: Promise<Units> = {} as never;
export const w: { nested: { amount: Units } } = {} as never;
export const x: Record<string, Units> = {} as never;
export const y: readonly [Units, string] = [] as never;
export const z: { amounts: bigint[] } = {} as never;
export const aa: Map<string, bigint> = new Map() as never;
`,
  });

  assert.deepEqual(
    found.map((violation) => violation.split(": ")[0]),
    [
      6, 7, 8, 9, 10, 11, 12, 13, 14, 19, 20, 21, 22, 23, 27, 28, 29, 30, 31, 35, 36, 37, 38, 39,
      40,
    ].map((line) => `src/casts.ts:${line}`)
  );
  assert.match(found[0], /asserts Units \(Units\)/);
  assert.match(found[9], /asserts Units \(never\)/);
});

test("allows the defining module, tests, `as const` and other types", () => {
  const found = castViolations({
    "src/fine.ts": `import { units } from "./lib/units";
export const one = units(1n);
export const literal = "x" as const;
export const plain = 1n as bigint;
`,
    "src/fine.test.ts": `import type { Units } from "./lib/units";\nexport const t = 1n as Units;\n`,
  });

  assert.deepEqual(found, []);
});

test("checks a file two programs load once", () => {
  const found = castViolations(
    {
      "src/cast.ts": `import type { Units } from "./lib/units";\nexport const a = 1n as Units;\n`,
      "web/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" },
        include: ["**/*.ts"],
      }),
      "web/page.ts": `import type { Units } from "../src/lib/units";
import { a } from "../src/cast";
export const b = a as Units;
`,
    },
    ["tsconfig.json", "web/tsconfig.json"]
  );

  assert.deepEqual(
    found.map((violation) => violation.split(": ")[0]),
    ["src/cast.ts:2", "web/page.ts:3"]
  );
});

test("fails when a branded type is missing from its module or from every program", () => {
  const rootDir = fixture({ "src/lib/units.ts": "export const nothing = 1;\n" });
  try {
    const check = (tsconfigs) =>
      findBrandedCastViolations({
        rootDir,
        tsconfigs,
        brandedTypes: BRANDED_TYPES,
        scanRoots: ["src/"],
      });
    assert.throws(() => check([]), /No program loads src\/lib\/units\.ts/);
    assert.throws(
      () => check([path.join(rootDir, "tsconfig.json")]),
      /does not export the type Units/
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// biome-ignore-start lint/security/noSecrets: SDK function names, not secrets.
test("pins token movement builders to their files, however they are imported", () => {
  const files = {
    "src/builder.ts":
      'import { getTransferCheckedInstruction } from "@solana-program/token-2022";\n',
    "src/renamed.ts":
      'import { getTransferCheckedInstruction as transfer } from "@solana-program/token";\n',
    "src/namespace.ts":
      'import * as token from "@solana-program/token-2022";\ntoken.getTransferCheckedWithFeeInstruction;\n',
    "src/keyed.ts":
      'import * as token from "@solana-program/token";\ntoken["getTransferCheckedInstruction"];\n',
    "src/destructured.ts":
      'import * as token from "@solana-program/token";\nconst { getTransferCheckedInstruction: transfer } = token;\n',
    // The namespace handed on: the check can no longer see what is read off it.
    "src/handed-on.ts": 'import * as token from "@solana-program/token";\nuse(token);\n',
    "apps/sdp-web/src/pay.tsx":
      'import { getTransferCheckedInstruction } from "@solana-program/token";\n',
    // A same-named parameter or local is not the namespace; the namespace's own use still counts.
    "src/shadowed.ts":
      'import * as token from "@solana-program/token";\ntoken.TOKEN_PROGRAM_ADDRESS;\nexport function format(token: string) {\n  return token;\n}\n',
    "src/shadowed-use.ts":
      'import * as token from "@solana-program/token";\nexport function format(token: string) {\n  return token;\n}\ntoken.getTransferCheckedInstruction;\n',
    "src/exported.ts": 'import * as token from "@solana-program/token";\nexport { token };\n',
    "src/exported-renamed.ts":
      'import * as token from "@solana-program/token";\nexport { token as spl };\n',
    // An alias is only a name, and a type-only export hands out no value.
    "src/alias-only.ts":
      'import * as token from "@solana-program/token";\ndeclare const x: number;\nexport { x as token };\nexport type { token as Types };\n',
    "src/dynamic.ts":
      'const { getTransferCheckedInstruction } = await import("@solana-program/token");\n',
    "src/required.ts": 'const token = require("@solana-program/token-2022");\n',
    "src/reexported.ts":
      'export { getTransferCheckedInstruction as transfer } from "@solana-program/token";\n',
    "src/reexported-all.ts": 'export * from "@solana-program/token-2022";\n',
    "src/reexported-type.ts": 'export type { Mint } from "@solana-program/token";\n',
    // Other members, a same-named property and a type read nothing pinned.
    "src/other-members.ts":
      'import * as token from "@solana-program/token";\ntoken.TOKEN_PROGRAM_ADDRESS;\nconst x = { token: 1 };\nlet m: typeof token;\n',
    // A repository method of the same name, and the package's constants: not a builder.
    "src/repository.ts":
      'import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";\nrepo.getTransferCheckedInstruction();\n',
    "src/builder.test.ts": 'import { getTransferInstruction } from "@solana-program/token";\n',
  };
  const rootDir = fixture(files);
  try {
    const violations = findTokenMovementBuilderViolations({
      rootDir,
      files: Object.keys(files),
      rules: [
        {
          id: "transfer",
          why: "builds a transfer",
          imports: [
            {
              packages: ["@solana-program/token", "@solana-program/token-2022"],
              names: ["getTransferCheckedInstruction", "getTransferCheckedWithFeeInstruction"],
            },
          ],
          allow: ["src/builder.ts", "src/gone.ts"],
        },
      ],
    });
    assert.deepEqual(violations, [
      "src/renamed.ts uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/namespace.ts uses getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/keyed.ts uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/destructured.ts uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/handed-on.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "apps/sdp-web/src/pay.tsx uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/shadowed-use.ts uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/exported.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/exported-renamed.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/dynamic.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/required.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/reexported.ts uses getTransferCheckedInstruction: it builds a transfer (transfer)",
      "src/reexported-all.ts uses getTransferCheckedInstruction, getTransferCheckedWithFeeInstruction: it builds a transfer (transfer)",
      "src/gone.ts no longer uses transfer: remove it from the list",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
// biome-ignore-end lint/security/noSecrets: SDK function names, not secrets.
