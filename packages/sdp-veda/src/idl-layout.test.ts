import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VEDA_ASSET_DATA_DISCRIMINATOR,
  VEDA_ASSET_DATA_LAYOUT,
  VEDA_BORING_VAULT_DISCRIMINATOR,
  VEDA_BORING_VAULT_LAYOUT,
  VEDA_BORING_VAULT_SIZE,
} from "@sdp/earn/providers/veda/vault-state";
import { describe, expect, it } from "vitest";

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  THE GUARD THAT MAKES `@sdp/earn`'s HAND-WRITTEN OFFSET TABLE FALSIFIABLE.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `@sdp/earn` decodes Veda vault state positionally, because it may not depend
 * on a chain SDK — its only dependency is `@sdp/types` and it runs the hourly
 * catalogue cron. A hand-maintained offset table that nothing can contradict is
 * how a silent ABI change becomes a silently wrong share mint on a customer's
 * strategy row.
 *
 * This package is the one that CAN contradict it: it holds Veda's published
 * Anchor IDLs, so the layout is recomputed here from the IDL's own field order
 * and compared field by field. It also compares the committed IDLs against the
 * SDK's shipped copies and their recorded SHA-256s, so "the IDL says so" cannot
 * quietly mean "the IDL we committed months ago says so".
 *
 * If Veda changes the ABI, this test fails on the next `pnpm install` — before
 * anything reads a wrong offset off a live account.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const IDL_DIR = join(HERE, "..", "idl");

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };
interface IdlField {
  name: string;
  type: IdlType;
}
interface IdlTypeDef {
  name: string;
  type:
    | { kind: "struct"; fields: IdlField[] }
    | { kind: "enum"; variants: { name: string; fields?: unknown[] }[] };
}
interface Idl {
  types: IdlTypeDef[];
  accounts: { name: string; discriminator: number[] }[];
}

const PRIMITIVE_SIZES: Readonly<Record<string, number>> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  u64: 8,
  i64: 8,
  f64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(join(IDL_DIR, `${name}.json`), "utf8")) as Idl;
}

const vaultIdl = loadIdl("boring_vault_svm");
const typesByName = new Map(vaultIdl.types.map((entry) => [entry.name, entry.type]));

function sizeOf(type: IdlType): number {
  if (typeof type === "string") {
    const size = PRIMITIVE_SIZES[type];
    if (size === undefined) throw new Error(`unsupported IDL primitive ${type}`);
    return size;
  }
  if ("array" in type) return sizeOf(type.array[0]) * type.array[1];
  return sizeOfTypeDef(type.defined.name);
}

function sizeOfTypeDef(name: string): number {
  const definition = typesByName.get(name);
  if (!definition) throw new Error(`unknown IDL type ${name}`);
  if (definition.kind === "struct") {
    return definition.fields.reduce((total, field) => total + sizeOf(field.type), 0);
  }
  // A fieldless Borsh enum is one byte. A data-carrying one is variable, which
  // would make the whole account unsizeable — worth failing loudly on.
  if (definition.variants.some((variant) => variant.fields)) {
    throw new Error(`${name} is a data-carrying enum and has no fixed size`);
  }
  return 1;
}

/** camelCase, matching how the offset table names the same fields. */
function camel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Flatten a struct into `[dottedName, offset]`, Borsh-style with no padding.
 *
 * STOPS at the first field whose size cannot be computed — `AssetData` ends in
 * a data-carrying `OracleSource` enum, and every field after it has no fixed
 * offset either. Stopping rather than throwing is what lets this derive the
 * fixed PREFIX that `@sdp/earn` actually reads.
 */
function flatten(typeName: string, prefix = "", start = 0): [string, number][] {
  const definition = typesByName.get(typeName);
  if (definition?.kind !== "struct") throw new Error(`${typeName} is not a struct`);
  const entries: [string, number][] = [];
  let offset = start;
  for (const field of definition.fields) {
    const name = `${prefix}${camel(field.name)}`;
    const nested =
      typeof field.type === "object" && "defined" in field.type
        ? typesByName.get(field.type.defined.name)
        : undefined;
    let size: number;
    try {
      size = sizeOf(field.type);
    } catch {
      break;
    }
    if (nested?.kind === "struct") {
      entries.push(
        ...flatten((field.type as { defined: { name: string } }).defined.name, `${name}.`, offset)
      );
    } else {
      entries.push([name, offset]);
    }
    offset += size;
  }
  return entries;
}

/**
 * The SDK's package root, found by walking up from its resolved entry point.
 *
 * `import.meta.resolve` rather than `require.resolve`: the SDK is ESM-only and
 * its `exports` map declares just `"."` with an `import` condition, so a CJS
 * resolver reaches neither the entry point nor `package.json`.
 */
function resolveSdkRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@vedatech/svm-sdk")));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, "programs.lock.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate the @vedatech/svm-sdk package root");
}

describe("the committed IDLs are Veda's own", () => {
  /**
   * The SDK ships the same IDLs plus a `programs.lock.json` recording the
   * source commit and a SHA-256 per file. Comparing against BOTH means a
   * committed IDL cannot drift from the SDK version this package pins, and the
   * SDK's own copy cannot have been altered relative to what it recorded.
   */
  it("matches the SDK's shipped copies, byte for byte and by recorded hash", () => {
    const sdkDir = resolveSdkRoot();
    const lock = JSON.parse(readFileSync(join(sdkDir, "programs.lock.json"), "utf8")) as {
      programs: Record<string, { idl: string; sha256: string }>;
    };

    expect(Object.keys(lock.programs).sort()).toEqual([
      "boring_onchain_queue",
      "boring_vault_svm",
      "hook_program",
    ]);

    for (const [name, entry] of Object.entries(lock.programs)) {
      const committed = readFileSync(join(IDL_DIR, `${name}.json`));
      const shipped = readFileSync(join(sdkDir, entry.idl));
      expect(committed.equals(shipped), `${name}.json differs from the SDK's copy`).toBe(true);
      expect(createHash("sha256").update(committed).digest("hex"), name).toBe(entry.sha256);
    }
  });
});

describe("@sdp/earn's BoringVault offsets match the IDL", () => {
  const expected = new Map(flatten("BoringVault", "", 8));

  it("agrees on the account's total size", () => {
    const total = 8 + sizeOfTypeDef("BoringVault");
    expect(VEDA_BORING_VAULT_SIZE).toBe(total);
    // Pinned as a literal too: a table that lost a field AND a derivation that
    // lost the same field would otherwise agree with each other.
    expect(total).toBe(512);
  });

  it("agrees on every offset the catalogue reads", () => {
    const derived: Record<string, number | undefined> = {};
    const declared: Record<string, number> = {};
    for (const [name, offset] of Object.entries(VEDA_BORING_VAULT_LAYOUT.offsets)) {
      if (name === "discriminator") continue;
      declared[name] = offset;
      derived[name] = expected.get(name);
    }
    expect(derived).toEqual(declared);
  });

  it("places the discriminator first", () => {
    expect(VEDA_BORING_VAULT_LAYOUT.offsets.discriminator).toBe(0);
  });

  it("uses the IDL's own account discriminator", () => {
    const account = vaultIdl.accounts.find((entry) => entry.name === "BoringVault");
    expect([...VEDA_BORING_VAULT_DISCRIMINATOR]).toEqual(account?.discriminator);
  });
});

describe("@sdp/earn's AssetData offsets match the IDL", () => {
  const expected = new Map(flatten("AssetData", "", 8));

  it("agrees on every offset in the fixed prefix", () => {
    for (const [name, offset] of Object.entries(VEDA_ASSET_DATA_LAYOUT.offsets)) {
      if (name === "discriminator") continue;
      expect(expected.get(name), name).toBe(offset);
    }
  });

  /**
   * The table stops before `oracle_source`, a data-carrying enum whose variants
   * differ in size. That is why `AssetData` is length-checked as a MINIMUM
   * rather than an exact size — asserted here so nobody "fixes" it into an
   * equality check.
   */
  it("stops before the variable-length tail", () => {
    expect(() => sizeOfTypeDef("AssetData")).toThrow(/no fixed size/);
    expect(Object.keys(VEDA_ASSET_DATA_LAYOUT.offsets)).not.toContain("oracleSource");
  });

  it("uses the IDL's own account discriminator", () => {
    const account = vaultIdl.accounts.find((entry) => entry.name === "AssetData");
    expect([...VEDA_ASSET_DATA_DISCRIMINATOR]).toEqual(account?.discriminator);
  });
});
