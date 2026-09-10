import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { address, createSolanaRpc, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "@/runtime/logger";

const getSignaturesForAddress = vi.hoisted(() => vi.fn());
const getTransaction = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({ getSignaturesForAddress, getTransaction }));

const { resolveDvpClose } = await import("./closing-transaction");
const SWAP = address("11111111111111111111111111111111");
const RPC = createSolanaRpc("http://localhost");
const SIGNATURE = signature(
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
);

const OTHER_SWAP = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

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
    await expect(resolveDvpClose(RPC, SWAP, "dvp_test", null)).resolves.toEqual({
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
    await expect(resolveDvpClose(RPC, SWAP, "dvp_test", null)).resolves.toEqual({
      status: "cancelled",
      signature: SIGNATURE,
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3, 4])(
    "ignores a closing instruction (discriminator %s) aimed at another trade",
    async (discriminator) => {
      getTransaction.mockResolvedValue(transaction(discriminator, OTHER_SWAP));
      await expect(resolveDvpClose(RPC, SWAP, "dvp_test", null)).resolves.toBeNull();
    }
  );

  it("returns null for create-only history", async () => {
    getTransaction.mockResolvedValue(transaction(0));
    await expect(resolveDvpClose(RPC, SWAP, "dvp_test", null)).resolves.toBeNull();
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

    await expect(resolveDvpClose(RPC, SWAP, "dvp_test", null)).resolves.toEqual({
      status: "settled",
      signature: SIGNATURE,
    });
    expect(getSignaturesForAddress).toHaveBeenNthCalledWith(2, RPC, SWAP, {
      limit: 100,
      before: SIGNATURE,
    });
  });

  it("returns null and warns when the history page cap is reached", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => getLogger());
    getSignaturesForAddress.mockResolvedValue(
      Array.from({ length: 100 }, () => ({
        signature: SIGNATURE,
        slot: 1n,
        blockTime: null,
        err: { InstructionError: [] },
      }))
    );

    await expect(resolveDvpClose(RPC, SWAP, "dvp_capped", null)).resolves.toBeNull();
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ trade_id: "dvp_capped" }),
      expect.stringContaining("page cap")
    );
  });

  it("stops scanning when it reaches the trade create signature", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);

    await expect(resolveDvpClose(RPC, SWAP, "dvp_test", SIGNATURE)).resolves.toBeNull();
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
});
