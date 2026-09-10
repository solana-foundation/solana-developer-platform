import { describe, expect, it } from "vitest";
import {
  TEST_OTHER_OWNER,
  TEST_OTHER_SIGNER_SECRET,
  TEST_OWNER,
  TEST_SIGNER_SECRET,
  testSigner,
  testSignMessage,
} from "./shielded-identity-fixtures.js";

/**
 * The hardcoded owner addresses let suites build a request at module scope, but
 * they are only correct as long as the secrets still derive them. Ed25519 is
 * deterministic, so this either passes forever or catches the moment a secret
 * changed and every golden identity moved with it.
 */
describe("test signer fixtures", () => {
  it("derives the hardcoded owner from the test secret", async () => {
    expect((await testSigner()).address).toBe(TEST_OWNER);
  });

  it("keeps the two test signers distinct", async () => {
    expect(TEST_OTHER_OWNER).not.toBe(TEST_OWNER);
    expect(TEST_OTHER_SIGNER_SECRET).not.toStrictEqual(TEST_SIGNER_SECRET);
  });

  it("refuses an owner it does not hold, as custody would", async () => {
    await expect(testSignMessage("AAAA", "11111111111111111111111111111111")).rejects.toThrow(
      /does not hold/
    );
  });
});
