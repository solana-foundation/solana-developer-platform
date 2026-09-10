import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { address, createSolanaRpc, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    await expect(resolveDvpClose(RPC, SWAP)).resolves.toEqual({ status, signature: SIGNATURE });
  });

  it("skips errored history entries", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: { InstructionError: [] } },
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    getTransaction.mockResolvedValue(transaction(3));
    await expect(resolveDvpClose(RPC, SWAP)).resolves.toEqual({
      status: "cancelled",
      signature: SIGNATURE,
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3, 4])(
    "ignores a closing instruction (discriminator %s) aimed at another trade",
    async (discriminator) => {
      getTransaction.mockResolvedValue(transaction(discriminator, OTHER_SWAP));
      await expect(resolveDvpClose(RPC, SWAP)).resolves.toBeNull();
    }
  );

  it("returns null for create-only history", async () => {
    getTransaction.mockResolvedValue(transaction(0));
    await expect(resolveDvpClose(RPC, SWAP)).resolves.toBeNull();
  });
});
