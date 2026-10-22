import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findBrandedCastViolations,
  findRpcDisplayValueViolations,
  findValueMovementViolations,
  RPC_DISPLAY_VALUES,
} from "./check-value-movement.mjs";

function fixture(files) {
  // The real path: TypeScript resolves packages through symlinks (macOS links `/var`).
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "value-movement-")));
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
      programs: [
        { tsconfig: path.join(rootDir, "tsconfig.json"), scanRoots: ["src/"], capabilities },
      ],
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

/** A third-party token program, installed only in the `src/pkg` workspace. */
const TOKEN_PACKAGE = {
  "src/pkg/package.json": JSON.stringify({ name: "pkg" }),
  "src/pkg/node_modules/token/package.json": JSON.stringify({ name: "token", types: "index.d.ts" }),
  "src/pkg/node_modules/token/index.d.ts": `export declare function transferChecked(amount: bigint): unknown;
export declare function decode(): unknown;
`,
};

const TRANSFER = {
  id: "token-movement-test",
  why: "transfer capability",
  symbols: [{ module: "token", name: "transferChecked", resolveFrom: "src/pkg" }],
  owners: [],
  allow: ["src/pkg/builder.ts"],
};

test("pins a third-party builder from the workspace that declares it, however it is imported", () => {
  const found = violations(
    {
      ...TOKEN_PACKAGE,
      "src/pkg/builder.ts": `import { transferChecked } from "token";\ntransferChecked(1n);\n`,
      "src/pkg/adapter.ts": `import { transferChecked as build } from "token";\nbuild(1n);\n`,
      "src/pkg/decoder.ts": `import { decode } from "token";\ndecode();\n`,
    },
    [{ ...TRANSFER, allow: ["src/pkg/builder.ts", "src/pkg/decoder.ts"] }]
  );

  assert.deepEqual([...new Set(found.map((violation) => violation.split(": ")[0]))].sort(), [
    "src/pkg/adapter.ts:1",
    "src/pkg/adapter.ts:2",
    "src/pkg/decoder.ts",
  ]);
  assert.match(
    found.find((v) => v.startsWith("src/pkg/decoder.ts")),
    /no longer references/
  );
});

test("cannot resolve a package from a workspace that does not declare it", () => {
  const files = {
    ...TOKEN_PACKAGE,
    "src/pkg/builder.ts": `import { transferChecked } from "token";\ntransferChecked(1n);\n`,
  };
  // Without `resolveFrom`, an unowned package resolves from the first root
  // file, `src/lib/cap.ts`, whose workspace has no `token`.
  const { resolveFrom: _, ...unanchored } = TRANSFER.symbols[0];
  assert.throws(
    () => violations(files, [{ ...TRANSFER, symbols: [unanchored] }]),
    /cannot resolve token from src\/lib\/cap\.ts/
  );
  assert.throws(
    () =>
      violations(files, [
        { ...TRANSFER, symbols: [{ ...TRANSFER.symbols[0], resolveFrom: "src/missing" }] },
      ]),
    /resolves from src\/missing, which has no package\.json/
  );
});

test("fails a workspace that imports another copy of a pinned package", () => {
  const found = violations(
    {
      ...TOKEN_PACKAGE,
      "src/pkg/builder.ts": `import { transferChecked } from "token";\ntransferChecked(1n);\n`,
      "src/other/package.json": JSON.stringify({ name: "other" }),
      "src/other/node_modules/token/package.json": JSON.stringify({
        name: "token",
        types: "index.d.ts",
      }),
      "src/other/node_modules/token/index.d.ts":
        "export declare function transferChecked(amount: bigint): unknown;\n",
      "src/other/uses.ts": `import { transferChecked } from "token";\ntransferChecked(1n);\n`,
    },
    [TRANSFER]
  );

  assert.equal(found.length, 1);
  assert.match(
    found[0],
    /^src\/other\/uses\.ts:1: imports a copy of token the check does not pin \(src\/other\/node_modules\/token\/index\.d\.ts\); every workspace must resolve it to src\/pkg\/node_modules\/token\/index\.d\.ts\./
  );
});

test("fails a pinned symbol that no program loads", () => {
  assert.throws(
    () =>
      violations({ ...TOKEN_PACKAGE, "src/pkg/builder.ts": "export const unrelated = 1;\n" }, [
        TRANSFER,
      ]),
    /No program loads token, so token-movement-test cannot pin transferChecked/
  );
});

test("scans the dashboard for its capabilities only, and a shared file once", () => {
  const rootDir = fixture({
    "src/lib/cap.ts": CAP_SOURCE,
    "src/shared.ts": `import { mint } from "./lib/cap";\nexport const one = () => mint();\n`,
    "src/api.ts": `import { Signer } from "./lib/cap";\nnew Signer();\n`,
    "web/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        noEmit: true,
      },
      include: ["**/*.ts"],
    }),
    // Allowlisted for a capability only the dashboard's program checks.
    "web/allowed.ts": `import { mint } from "../src/lib/cap";\nmint();\n`,
    "web/page.ts": `import { mint, Signer } from "../src/lib/cap";
import { one } from "../src/shared";
mint();
new Signer();
one();
`,
  });
  const movement = {
    id: "movement",
    why: "movement capability",
    symbols: [{ file: "src/lib/cap.ts", name: "mint" }],
    owners: ["src/lib/cap.ts"],
    allow: ["web/allowed.ts"],
  };
  const signing = {
    id: "signing",
    why: "signing capability",
    symbols: [{ file: "src/lib/cap.ts", name: "Signer" }],
    owners: ["src/lib/cap.ts"],
    allow: [],
  };
  try {
    const found = findValueMovementViolations({
      rootDir,
      programs: [
        {
          tsconfig: path.join(rootDir, "web/tsconfig.json"),
          scanRoots: ["web/", "src/"],
          capabilities: [movement],
        },
        {
          tsconfig: path.join(rootDir, "tsconfig.json"),
          scanRoots: ["src/"],
          capabilities: [movement, signing],
        },
      ],
    });

    assert.deepEqual(found.map((violation) => violation.split(" (")[0]).sort(), [
      "src/api.ts:1: references signing",
      "src/api.ts:2: references signing",
      "src/shared.ts:1: references movement",
      "src/shared.ts:2: references movement",
      "web/page.ts:1: references movement",
      "web/page.ts:3: references movement",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
`,
  });

  assert.deepEqual(
    found.map((violation) => violation.split(": ")[0]),
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23].map((line) => `src/casts.ts:${line}`)
  );
  assert.match(found[0], /asserts Units \(Units\)/);
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

/** Kit's `TokenAmount`, at the path every installed copy of `@solana/rpc-types` has. */
const RPC_TYPES = {
  "node_modules/@solana/rpc-types/package.json": JSON.stringify({
    name: "@solana/rpc-types",
    types: "dist/types/index.d.ts",
  }),
  "node_modules/@solana/rpc-types/dist/types/index.d.ts":
    'export type { TokenAmount } from "./token-amount";\n',
  "node_modules/@solana/rpc-types/dist/types/token-amount.d.ts": `export type TokenAmount = Readonly<{
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}>;
`,
};

const DISPLAY_FIELDS = { ...RPC_DISPLAY_VALUES, owner: "src/rpc/" };

function displayViolations(files) {
  const rootDir = fixture({ ...RPC_TYPES, ...files });
  try {
    return findRpcDisplayValueViolations({
      rootDir,
      tsconfigs: [path.join(rootDir, "tsconfig.json")],
      fields: DISPLAY_FIELDS,
      scanRoots: ["src/"],
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("flags every read or write of the RPC's display values outside the RPC layer", () => {
  const found = displayViolations({
    "src/reads.ts": `import type { TokenAmount } from "@solana/rpc-types";
declare const balance: TokenAmount;
declare const parsed: { uiTokenAmount: TokenAmount } | undefined;
declare const narrowed: Omit<TokenAmount, "uiAmount" | "uiAmountString">;
export const raw = narrowed.amount;
export const a = balance.uiAmount;
export const b = parsed?.uiTokenAmount.uiAmountString;
export const c = balance["uiAmountString"];
const { uiAmount } = balance;
const { uiAmountString: shown } = balance;
export const d = { ...balance }.uiAmount;
export const e: TokenAmount = { amount: "1", decimals: 0, uiAmount: 1, uiAmountString: "1" };
export const f = [uiAmount, shown];
`,
    "src/local.ts": "const own = { uiAmount: 1 };\nexport const g = own.uiAmount;\n",
    "src/rpc/strip.ts": `import type { TokenAmount } from "@solana/rpc-types";
export const strip = ({ amount, decimals, uiAmount }: TokenAmount) => ({ amount, decimals, uiAmount });
`,
    "src/reads.test.ts": `import type { TokenAmount } from "@solana/rpc-types";
declare const balance: TokenAmount;
export const t = balance.uiAmount;
`,
  });

  assert.deepEqual(
    found.map((violation) => violation.split(", ")[0]),
    [
      "src/reads.ts:6: references uiAmount",
      "src/reads.ts:7: references uiAmountString",
      "src/reads.ts:8: references uiAmountString",
      "src/reads.ts:9: references uiAmount",
      "src/reads.ts:10: references uiAmountString",
      "src/reads.ts:11: references uiAmount",
      "src/reads.ts:12: references uiAmount",
      "src/reads.ts:12: references uiAmountString",
    ]
  );
});

test("fails when no program loads the RPC's token amount", () => {
  assert.throws(
    () => displayViolations({ "src/plain.ts": "export const one = 1;\n" }),
    /No program loads \/node_modules\/@solana\/rpc-types\/dist\/types\/token-amount\.d\.ts/
  );
});
