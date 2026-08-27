import { encodeUnsignedTransactionBase64 } from "@sdp/helius-rings-sdk/testing";
import { getBase64Codec, getTransactionDecoder, getTransactionEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

/**
 * The Kit 6/Kit 7 boundary, asserted from the side that has to live with it.
 *
 * `@sdp/helius-rings-sdk` is pinned to `@solana/kit` 7 because Zolana requires
 * it; this app is on 6. Type checking already proves no branded type crosses,
 * but the port also carries an encoded transaction as base64, and a wire format
 * that drifted between majors would fail at signing time on devnet rather than
 * in CI. The imports below are this app's Kit 6; the producer is the package's
 * Kit 7.
 */

const FEE_PAYER = "GxWDgXCZmvdwtsyzxA9V8v5H2VYcPYFbLPmSF6bZW8sT";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";

describe("Kit 6 reading what Kit 7 produced", () => {
  const encoded = encodeUnsignedTransactionBase64({
    feePayer: FEE_PAYER,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000n,
  });

  it("decodes a Kit 7 transaction with the Kit 6 decoder the signer uses", () => {
    const decoded = getTransactionDecoder().decode(getBase64Codec().encode(encoded));

    expect(decoded.messageBytes.length).toBeGreaterThan(0);
    expect(Object.keys(decoded.signatures)).toEqual([FEE_PAYER]);
  });

  it("re-encodes byte-identically, so nothing is lost across the majors", () => {
    const bytes = getBase64Codec().encode(encoded);
    const roundTripped = getTransactionEncoder().encode(getTransactionDecoder().decode(bytes));

    expect(getBase64Codec().decode(roundTripped)).toBe(encoded);
  });
});
