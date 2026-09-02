import { describe, expect, it } from "vitest";
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
