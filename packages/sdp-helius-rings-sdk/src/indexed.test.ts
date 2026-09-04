import { describe, expect, it, vi } from "vitest";
import { verifyRingsIndexed } from "./indexed.js";

describe("verifyRingsIndexed", () => {
  function clientReturning(response: unknown) {
    return { getShieldedTransactionsBySignature: vi.fn(async () => response) } as never;
  }

  it("returns null while Photon has no events for the signature", async () => {
    const client = clientReturning({
      context: { slot: 1n, blockTime: 1_800_000_000n },
      transactions: [],
    });

    await expect(verifyRingsIndexed(client, "sig")).resolves.toBeNull();
  });

  it("dates the observation by Photon's clock rather than this process's", async () => {
    const client = clientReturning({
      context: { slot: 9n, blockTime: 1_800_000_000n },
      transactions: [{ eventIndex: 0, transaction: { slot: 9n } }],
    });

    const result = await verifyRingsIndexed(client, "sig111");

    expect(result?.indexedAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("references the indexed event, not the signature it was asked about", async () => {
    const client = clientReturning({
      context: { slot: 9n, blockTime: 1_800_000_000n },
      transactions: [{ eventIndex: 2, transaction: { slot: 9n } }],
    });

    const result = await verifyRingsIndexed(client, "sig111");

    expect(result?.photonRef).toBe("sig111#2");
  });

  // A local validator reports zero, and 1970 would be worse than approximate.
  it("falls back to the local clock when the indexer reports no block time", async () => {
    const client = clientReturning({
      context: { slot: 9n, blockTime: 0n },
      transactions: [{ eventIndex: 0, transaction: { slot: 9n } }],
    });

    const result = await verifyRingsIndexed(client, "sig111");

    expect(Date.parse(result?.indexedAt ?? "")).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
  });
});
