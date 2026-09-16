import { describe, expect, it } from "vitest";
import * as generatedPrograms from "./generated/programs";
import * as publicSurface from "./index";

/**
 * The unchecked generated readers decode any bytes at any address with no
 * owner or size check. `CreateDvp` is permissionless, so reaching for one of
 * these by tab-completion is how a forged trade gets funded. Keeping them off
 * the barrel is the enforcement; this test is what stops a future
 * `export * from "./generated"` quietly undoing it.
 */
const UNCHECKED_READERS = [
  "fetchSwapDvp",
  "fetchMaybeSwapDvp",
  "fetchAllSwapDvp",
  "fetchAllMaybeSwapDvp",
  "decodeSwapDvp",
] as const;

describe("@sdp/dvp public surface", () => {
  it.each(UNCHECKED_READERS)("does not export the unchecked reader %s", (name) => {
    expect(publicSurface).not.toHaveProperty(name);
  });

  // Keeping the named readers off the barrel is not enough on its own. The
  // codama program plugin installs `addSelfFetchFunctions(client, getSwapDvpCodec())`,
  // so `client.accounts.swapDvp.fetch(address)` would decode a
  // counterparty-supplied account with no owner, size or PDA check — the same
  // bypass by a more idiomatic route.
  it("does not export the program plugin, whose client installs unchecked account fetches", () => {
    expect(publicSurface).not.toHaveProperty("dvpSwapProgramProgram");
  });

  // Structural rather than name-by-name: anything the generated programs module
  // exports is only allowed onto the barrel if it is on this list. A future
  // codama version adding another account-reaching helper fails here instead of
  // quietly widening the public surface.
  it("re-exports only inert symbols from the generated programs module", () => {
    const SAFE_PROGRAM_EXPORTS = new Set([
      "DVP_SWAP_PROGRAM_PROGRAM_ADDRESS",
      "DVP_SWAP_PROGRAM_ADDRESS",
      "DvpSwapProgramAccount",
      "DvpSwapProgramInstruction",
      "identifyDvpSwapProgramInstruction",
      "parseDvpSwapProgramInstruction",
    ]);

    const leaked = Object.keys(generatedPrograms).filter(
      (name) => name in publicSurface && !SAFE_PROGRAM_EXPORTS.has(name)
    );

    expect(leaked).toEqual([]);
  });

  it("exports the checked readers that replace them", () => {
    expect(publicSurface.verifySwapDvp).toBeTypeOf("function");
    expect(publicSurface.decodeSwapDvpChecked).toBeTypeOf("function");
    expect(publicSurface.assertSwapDvpTerms).toBeTypeOf("function");
  });

  it("targets the program deployed on devnet", () => {
    expect(publicSurface.DVP_SWAP_PROGRAM_ADDRESS).toBe(
      "dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq"
    );
  });
});
