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
