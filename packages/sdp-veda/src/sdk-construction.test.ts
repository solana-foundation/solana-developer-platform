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
 * Every property below is invisible to the type checker AND to any runtime
 * assertion — each is a fact about how the code is WRITTEN, and each guards a
 * failure that is silent in production. A source grep is the honest tool.
 */

/**
 * Match a real module IMPORT, not a mention. The doc comments in `index.ts` and
 * `types.ts` name the SDK deliberately — explaining the boundary is the point —
 * so a naive substring scan flags exactly the files that document the rule.
 */
function importsModule(body: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:from|import|require\\()\\s*["']${escaped}["']`).test(body);
}

describe("the @vedatech/svm-sdk firewall", () => {
  it("confines the SDK import to sdk.ts", () => {
    const offenders = sourceFiles.filter(
      (file) => file !== "sdk.ts" && importsModule(read(file), "@vedatech/svm-sdk")
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the SDK out of the package's public entry point", () => {
    expect(importsModule(read("index.ts"), "@vedatech/svm-sdk")).toBe(false);
  });

  it("still detects a real import — the guard is not vacuous", () => {
    expect(importsModule('import { X } from "@vedatech/svm-sdk";', "@vedatech/svm-sdk")).toBe(true);
    expect(importsModule("// mentions @vedatech/svm-sdk in prose", "@vedatech/svm-sdk")).toBe(
      false
    );
  });
});

describe("cluster binding", () => {
  /**
   * The addresses reach the SDK explicitly, per cluster. Veda's SDK ships no
   * default addresses today; asserting the explicit form is what notices if a
   * future revision starts deriving one and this package stops supplying it.
   */
  it("constructs the SDK client with explicit deployment addresses", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toMatch(/createVedaClient\(\{[\s\S]*?vaultProgramAddress:\s*config\./);
    expect(sdk).toMatch(/createVedaClient\(\{[\s\S]*?hookProgramAddress:\s*config\./);
  });

  it("re-checks emitted instructions against the cluster allowlist", () => {
    const sdk = read("sdk.ts");
    const builders = sdk.match(/assertPlanTargetsCluster\(/g) ?? [];
    // Every plan builder must guard its OUTPUT: construction is a convention
    // inside one function, the assertion is a property of what we emit.
    expect(builders.length).toBeGreaterThanOrEqual(1);
    const body = sdk.slice(sdk.indexOf("export async function buildVedaDepositPlan"));
    expect(body).toContain("assertPlanTargetsCluster(");
  });

  /**
   * No mainnet address may be hardcoded outside the registry in `@sdp/types`.
   * Cluster-invariant program ids (system, token, ATA, memo, compute budget,
   * ed25519) live in the allowlist by design; anything else that looks like a
   * pubkey is an address someone typed instead of configuring.
   */
  it("hardcodes no vault, queue or hook address in this package's source", () => {
    const invariant = new Set(
      (read("programs.ts").match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? []).map((quoted) =>
        quoted.slice(1, -1)
      )
    );
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const quoted of read(file).match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? []) {
        const value = quoted.slice(1, -1);
        if (!invariant.has(value)) offenders.push(`${file}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("money-in requires a way out", () => {
  /**
   * ADR 0002's exit-safety rule, asserted at the source level because it is one
   * argument in one call. `requireQueue: true` is what stops SDP opening a
   * position in a vault whose withdrawal queue is not configured and wired.
   */
  it("validates the deployment with the queue REQUIRED before building", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain("validateCompatibility({ requireQueue: true })");
    expect(sdk).toContain("validateDeployment()");
    const body = sdk.slice(sdk.indexOf("export async function buildVedaDepositPlan"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("assertVedaVaultUsable(");
  });

  /** A failed verdict must never be remembered; only a passing one is cached. */
  it("evicts a failed compatibility verdict rather than caching it", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toMatch(/catch\s*\(cause\)\s*\{[\s\S]*?compatibility\.delete\(key\)/);
  });
});

describe("slippage protection is never invented", () => {
  /**
   * Veda's SDK refuses an implicit tolerance, and so does SDP: `minAmountOut`
   * carries the caller's own floor, and `slippageBps` — which would be SDP
   * choosing one — must appear nowhere.
   */
  it("passes minAmountOut and never a bps tolerance", () => {
    const sdk = read("sdk.ts");
    expect(sdk).toContain("protection: { minAmountOut:");
    for (const file of sourceFiles) {
      expect(read(file), file).not.toMatch(/slippageBps\s*:/);
    }
  });
});
