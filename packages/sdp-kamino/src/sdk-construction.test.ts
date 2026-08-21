import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const sourceFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/**
 * Structural tests over this package's own source.
 *
 * Both properties below are invisible to the type checker and to any runtime
 * assertion — they are facts about how the code is WRITTEN, and each guards a
 * failure that is silent in production. A source grep is the honest tool.
 */
/**
 * Match a real module IMPORT, not a mention. The doc comments in `index.ts` and
 * `types.ts` name klend-sdk deliberately — explaining the boundary is the point
 * — so a naive substring scan flags exactly the files that document the rule.
 */
function importsModule(body: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:from|import|require\\()\\s*["']${escaped}["']`).test(body);
}

describe("the klend-sdk firewall", () => {
  it("confines klend-sdk and decimal.js imports to sdk.ts", () => {
    const offenders = sourceFiles.filter((file) => {
      if (file === "sdk.ts") return false;
      const body = read(file);
      // Anywhere else, these drag klend-sdk's kit-2 copy (and a 13MB
      // dependency) into modules that must stay on this repo's kit 6.8.
      return importsModule(body, "@kamino-finance/klend-sdk") || importsModule(body, "decimal.js");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the SDK out of the package's public entry point", () => {
    expect(importsModule(read("index.ts"), "@kamino-finance/klend-sdk")).toBe(false);
  });

  it("still detects a real import — the guard is not vacuous", () => {
    expect(
      importsModule('import { X } from "@kamino-finance/klend-sdk";', "@kamino-finance/klend-sdk")
    ).toBe(true);
    expect(
      importsModule("// mentions @kamino-finance/klend-sdk in prose", "@kamino-finance/klend-sdk")
    ).toBe(false);
  });
});

describe("vault construction", () => {
  /**
   * THE TRAP, ASSERTED AT THE SOURCE LEVEL.
   *
   * `new KaminoVault(rpc, addr, state, programId)` binds the program id to
   * account READS only — its constructor builds an internal KaminoVaultClient
   * without forwarding it, so instructions come out addressed to MAINNET. On
   * devnet that means reading `devkRng…` state and emitting `KvauGM…`
   * instructions, with no error at any layer.
   *
   * `loadWithClientAndState` is the only factory that binds both. The one
   * permitted `new KaminoVault(` is the state probe, which is never used to
   * build anything — so this asserts the safe factory is present rather than
   * banning the constructor outright.
   */
  it("uses loadWithClientAndState to bind reads and writes together", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain("KaminoVault.loadWithClientAndState");
  });

  it("passes an explicit kvault program id to KaminoVaultClient", () => {
    const sdk = read("sdk.ts");
    // The client is what builds instructions; leaving its program id to the
    // SDK default is precisely how the mainnet id leaks onto devnet.
    expect(sdk).toMatch(/new KaminoVaultClient\([\s\S]*?kvaultProgramId/);
  });

  it("routes every entry point through the single bind helper", () => {
    const sdk = read("sdk.ts");
    for (const entry of [
      "buildKaminoDepositPlan",
      "buildKaminoWithdrawPlan",
      "readKaminoPosition",
    ]) {
      const body = sdk.slice(sdk.indexOf(`export async function ${entry}`));
      const fnBody = body.slice(0, body.indexOf("\n}\n") + 3);
      expect(fnBody, `${entry} must construct its vault via bindVault`).toContain("bindVault(");
    }
  });

  it("re-checks emitted instructions against the cluster allowlist", () => {
    const sdk = read("sdk.ts");
    const builders = sdk.match(/assertPlanTargetsCluster\(/g) ?? [];
    // Both plan builders must guard their output; the bind helper's correctness
    // is a convention inside one call, the assertion is a property of the output.
    expect(builders.length).toBeGreaterThanOrEqual(2);
  });

  it("binds every plan to the asset mints read from live vault state", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain("vaultAssetIdentityFromState(state)");
    // Deposit and withdrawal must both return the identity produced by the
    // shared bind path (the `assetIdentity` shorthand only exists as a
    // destructure of bindVault's result); omitting either would reopen
    // catalogue-only trust.
    expect(sdk.match(/^\s*assetIdentity,$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("fails closed on invalid observed shares but only withholds an invalid valuation", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain(
      'requireNonNegativeFiniteDecimal("staked share balance", staked.stakedShares)'
    );
    expect(sdk).toMatch(/requireNonNegativeFiniteDecimal\(\s*"total share balance"/);
    expect(sdk).toMatch(/requireNonNegativeFiniteDecimal\(\s*"vault exchange rate"/);
    expect(sdk).toMatch(
      /let tokenValue:[\s\S]*?try\s*\{[\s\S]*?requireNonNegativeFiniteDecimal\(\s*"vault exchange rate"/
    );
  });

  it("fails closed if the patched klend-sdk shares-state method disappears", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain('typeof sdkClient.getUserSharesState !== "function"');
    expect(sdk).toContain(
      "klend-sdk no longer exposes getUserSharesState required for safe consolidation"
    );
  });
});
