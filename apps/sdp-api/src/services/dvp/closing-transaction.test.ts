import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { address, createSolanaRpc, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignaturesForAddress = vi.hoisted(() => vi.fn());
const getTransaction = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({ getSignaturesForAddress, getTransaction }));

const { CREATE_TIME_SKEW_SECONDS, resolveDvpClose } = await import("./closing-transaction");
const SWAP = address("11111111111111111111111111111111");
const RPC = createSolanaRpc("http://localhost");
const SIGNATURE = signature(
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
);

const OTHER_SWAP = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CREATED_AT = "2026-09-11T00:00:00.000Z";

/**
 * Creates the parsed transaction wrapper for one DvP discriminator, closing
 * `swapDvp` (account index 1, as in Settle, Cancel and Reject).
 */
function transaction(discriminator: number, swapDvp: string = SWAP) {
  return {
    slot: 1n,
    err: null,
    instructions: [
      {
        programId: DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
        accounts: ["AuthorityOrSigner", swapDvp],
        data: getBase58Decoder().decode(new Uint8Array([discriminator])),
        parsedType: null,
        info: null,
      },
    ],
  };
}

describe("resolveDvpClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
  });

  it.each([
    [2, "settled"],
    [3, "cancelled"],
    [4, "rejected"],
  ] as const)("decodes discriminator %s as %s", async (discriminator, status) => {
    getTransaction.mockResolvedValue(transaction(discriminator));
    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status,
      signature: SIGNATURE,
    });
  });

  it("skips errored history entries", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: { InstructionError: [] } },
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    getTransaction.mockResolvedValue(transaction(3));
    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "cancelled",
      signature: SIGNATURE,
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3, 4])(
    "ignores a closing instruction (discriminator %s) aimed at another trade",
    async (discriminator) => {
      getTransaction.mockResolvedValue(transaction(discriminator, OTHER_SWAP));
      await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
        kind: "absent",
      });
    }
  );

  it("returns null for create-only history", async () => {
    getTransaction.mockResolvedValue(transaction(0));
    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "absent",
    });
  });

  it("finds a close on the second history page", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      signature: SIGNATURE,
      slot: 2n,
      blockTime: null,
      err: { InstructionError: [] },
    }));
    getSignaturesForAddress
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ signature: SIGNATURE, slot: 1n, blockTime: null, err: null }]);
    getTransaction.mockResolvedValue(transaction(2));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "settled",
      signature: SIGNATURE,
    });
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(2, RPC, SWAP, {
      limit: 100,
      before: SIGNATURE,
    });
  });

  it("returns capped after paying the bounded successful-entry lookup cost", async () => {
    getSignaturesForAddress.mockResolvedValue(
      Array.from({ length: 100 }, () => ({
        signature: SIGNATURE,
        slot: 1n,
        blockTime: null,
        err: null,
      }))
    );
    getTransaction.mockResolvedValue(transaction(0));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "capped",
    });
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(10);
    expect(getTransaction).toHaveBeenCalledTimes(1_000);
  });

  it("stops scanning when it reaches the trade create signature", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);

    await expect(resolveDvpClose(RPC, SWAP, SIGNATURE, CREATED_AT)).resolves.toEqual({
      kind: "absent",
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(getSignaturesForAddress).toHaveBeenCalledWith(RPC, SWAP, {
      limit: 100,
      until: SIGNATURE,
    });
  });

  it("omits until without a create signature", async () => {
    getTransaction.mockResolvedValue(transaction(0));
    await resolveDvpClose(RPC, SWAP, null, CREATED_AT);
    expect(getSignaturesForAddress).toHaveBeenCalledWith(RPC, SWAP, { limit: 100 });
  });

  it("stops before reading a transaction older than the created-at floor", async () => {
    getSignaturesForAddress.mockResolvedValue([
      {
        signature: SIGNATURE,
        slot: 1n,
        blockTime: BigInt(Math.floor(Date.parse(CREATED_AT) / 1000) - CREATE_TIME_SKEW_SECONDS - 1),
        err: null,
      },
    ]);
    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "absent",
    });
    expect(getTransaction).not.toHaveBeenCalled();
  });
});
