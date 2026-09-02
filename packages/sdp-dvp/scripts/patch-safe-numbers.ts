// biome-ignore-all lint/security/noSecrets: codec identifiers matched in generated source, not credentials.
/**
 * Hardens the generated codecs against silent precision loss on 64-bit values.
 *
 * Ported from `solana-foundation/dvp`'s `scripts/lib/patch-typescript-safe-numbers.ts`
 * (MIT). `@codama/renderers-js` types every u64/i64 arg as `number | bigint`
 * and encodes with kit's `getU64Encoder` / `getI64Encoder`, which round any
 * `number` above `Number.MAX_SAFE_INTEGER` before it reaches the wire. Here
 * that value is a trade amount or the nonce — and the nonce is a PDA seed, so
 * rounding derives a different address entirely.
 *
 * Runs after the JS render, over the instruction and account codecs:
 *   1. narrows `number | bigint` to `bigint` in generated arg types, and
 *   2. swaps bare encoder calls for the guarded `getSafe*` variants, which
 *      throw on a `number` so plain-JS callers can't round either.
 *
 * Decoders are left alone — they already return `bigint`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNGUARDED = ["number | bigint", "getU64Encoder()", "getI64Encoder()"] as const;

/** Rewrites one generated codec file in place. Returns false if it has no 64-bit surface. */
function patchFile(filePath: string): boolean {
  const src = readFileSync(filePath, "utf-8");

  const usesU64 = src.includes("getU64Encoder()");
  const usesI64 = src.includes("getI64Encoder()");
  if (!usesU64 && !usesI64) return false;

  let patched = src
    .split("number | bigint")
    .join("bigint")
    .split("getU64Encoder()")
    .join("getSafeU64Encoder()")
    .split("getI64Encoder()")
    .join("getSafeI64Encoder()");

  // Those were the only uses of the raw kit encoders, so drop the now-unused
  // named imports (codama renders one specifier per line, 2-space indented).
  // The matching decoders are untouched.
  if (usesU64) patched = patched.replace(/^ {2}getU64Encoder,\n/m, "");
  if (usesI64) patched = patched.replace(/^ {2}getI64Encoder,\n/m, "");

  // generated/instructions and generated/accounts both sit two levels below
  // src/, so the hand-written helper is at ../../safeNumberCodecs.
  const guards = [
    usesU64 ? "getSafeU64Encoder" : null,
    usesI64 ? "getSafeI64Encoder" : null,
  ].filter(Boolean);
  writeFileSync(
    filePath,
    `import { ${guards.join(", ")} } from "../../safeNumberCodecs";\n${patched}`
  );
  return true;
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

export function patchSafeNumbers(generatedDir: string): void {
  // Both instruction args and account fields serialize 64-bit values.
  const files = [join(generatedDir, "instructions"), join(generatedDir, "accounts")].flatMap(
    tsFilesIn
  );

  const filesPatched = files.filter(patchFile).length;

  // Safety net: if a codama template change makes the patch a no-op, fail
  // codegen loudly rather than shipping the rounding bug.
  for (const filePath of files) {
    const src = readFileSync(filePath, "utf-8");
    const leaked = UNGUARDED.find((pattern) => src.includes(pattern));
    if (leaked) {
      throw new Error(
        `patchSafeNumbers: unguarded 64-bit surface "${leaked}" still present in ${filePath}`
      );
    }
  }

  console.log(`Guarded 64-bit values against number rounding in ${filesPatched} file(s).`);
}
