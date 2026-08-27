import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { describe, expect, it, vi } from "vitest";
import { verifyRingsIndexed } from "./indexed.js";

/**
 * The distinction under test is "not yet" versus "indexed". Getting it wrong in
 * either direction is costly: a false "indexed" completes an operation that
 * never settled, and a false "not yet" leaves a settled one to time out.
 */

function clientReturning(
  transactions: unknown[]
): Pick<ZolanaClient, "getShieldedTransactionsBySignature"> {
  return {
    getShieldedTransactionsBySignature: vi.fn().mockResolvedValue({ transactions }),
  } as unknown as Pick<ZolanaClient, "getShieldedTransactionsBySignature">;
}

describe("verifyRingsIndexed", () => {
  it("reports not-indexed as null rather than an error", async () => {
    // The expected answer for most of an operation's time in `indexing`. The
    // poll, not this function, decides when waiting has gone on too long.
    await expect(verifyRingsIndexed(clientReturning([]), "sig")).resolves.toBeNull();
  });

  it("reports the slot and event Photon indexed it at", async () => {
    const client = clientReturning([{ eventIndex: 2, transaction: { slot: 1234n } }]);

    const result = await verifyRingsIndexed(client, "sig_abc");

    // The slot travels as its own field, not parsed back out of the reference
    // label: the next read gates on it, so it must not depend on formatting.
    expect(result?.slot).toBe("1234");
    expect(result?.photonRef).toBe("event:2");
    expect(result?.indexedAt).toEqual(expect.any(String));
  });

  it("asks Photon for the one signature it is waiting on", async () => {
    const client = clientReturning([]);

    await verifyRingsIndexed(client, "sig_specific");

    // By signature, never a scan: the operation already knows which
    // transaction it is waiting for.
    expect(client.getShieldedTransactionsBySignature).toHaveBeenCalledWith("sig_specific");
  });
});
