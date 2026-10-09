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
  symbols: [
    { file: "src/lib/cap.ts", name: "mint" },
    { file: "src/lib/cap.ts", name: "Signer", member: "sign" },
  ],
  owners: ["src/lib/cap.ts"],
  allow: ["src/allowed.ts"],
  shrinkOnly: true,
};

const CAP_SOURCE = `export function mint(): number { return 1; }
export class Signer { sign(): void {} }
`;

function violations(files, capabilities = [CAPABILITY]) {
  const rootDir = fixture({ "src/lib/cap.ts": CAP_SOURCE, ...files });
  try {
    return findValueMovementViolations({
      rootDir,
      tsconfig: path.join(rootDir, "tsconfig.json"),
      capabilities,
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

test("flags a class method capability called through an instance", () => {
  const found = violations({
    "src/allowed.ts": `import { mint } from "./lib/cap";\nmint();\n`,
    "src/method.ts": `import { Signer } from "./lib/cap";\nnew Signer().sign();\n`,
  });

  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/method\.ts:2: references admit \(sign\)/);
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
    "src/element.ts": `import { Signer } from "./lib/cap";\nnew Signer()["sign"]();\n`,
    "src/dynamic.ts": `export async function load() {\n  return import("./lib/cap");\n}\n`,
    "src/star.ts": `export * from "./lib/cap";\n`,
  });

  const flagged = new Set(found.map((violation) => violation.split(":")[0]));
  assert.deepEqual(
    [...flagged].sort(),
    ["src/destructure.ts", "src/dynamic.ts", "src/element.ts", "src/star.ts"].sort()
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
