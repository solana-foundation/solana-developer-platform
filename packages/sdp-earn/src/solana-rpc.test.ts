import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromBase64, toBase58 } from "./solana-rpc";

describe("catalogue byte encoding", () => {
  it("preserves leading zeros and the existing empty-input sentinel", () => {
    assert.equal(toBase58(new Uint8Array()), "1");
    assert.equal(toBase58(new Uint8Array(32)), "1".repeat(32));
    assert.equal(toBase58(Uint8Array.of(0, 0, 1)), "112");
    assert.equal(toBase58(Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255)), "jpXCZedGfVQ");
    assert.equal(toBase58(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  });

  it("decodes every byte and accepts atob whitespace and omitted padding", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    assert.deepEqual(fromBase64(Buffer.from(bytes).toString("base64")), bytes);
    assert.deepEqual(fromBase64(" AAEC /w==\n"), Uint8Array.of(0, 1, 2, 255));
    assert.deepEqual(fromBase64("AAEC/w"), Uint8Array.of(0, 1, 2, 255));
    assert.deepEqual(fromBase64(""), new Uint8Array());
  });

  it("refuses malformed RPC base64 instead of silently discarding characters", () => {
    for (const encoded of ["A", "A===", "AA$=", "AA-_", "é"]) {
      assert.throws(() => fromBase64(encoded), { name: "InvalidCharacterError" });
    }
  });
});
