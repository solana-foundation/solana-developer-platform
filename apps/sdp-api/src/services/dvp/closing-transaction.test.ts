import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { address, createSolanaRpc, getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignaturesForAddress = vi.hoisted(() => vi.fn());
const getTransaction = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({ getSignaturesForAddress, getTransaction }));

const { CREATE_TIME_SKEW_SECONDS, resolveDvpClose, TRANSACTION_LOOKUP_CONCURRENCY } = await import(
  "./closing-transaction"
);
const SWAP = address("11111111111111111111111111111111");
const RPC = createSolanaRpc("http://localhost");
const SIGNATURE = signature(
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
);
const CREATE_SIGNATURE = signature(getBase58Decoder().decode(new Uint8Array(64).fill(1)));

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

  it("overlaps a page's transaction fetches without exceeding the concurrency bound", async () => {
    getSignaturesForAddress.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        signature: SIGNATURE,
        slot: 1n,
        blockTime: null,
        err: null,
      }))
    );
    let inFlight = 0;
    let maxInFlight = 0;
    getTransaction.mockImplementation(
      () =>
        new Promise((resolveGate) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          queueMicrotask(() => {
            inFlight -= 1;
            resolveGate(null);
          });
        })
    );

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "absent",
    });
    expect(getTransaction).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(TRANSACTION_LOOKUP_CONCURRENCY);
  });

  it("returns the moment the earliest close settles instead of waiting for later lookups", async () => {
    getSignaturesForAddress.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        signature: SIGNATURE,
        slot: 1n,
        blockTime: null,
        err: null,
      }))
    );
    getTransaction
      .mockResolvedValueOnce(transaction(2))
      .mockImplementation(() => new Promise(() => {}));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "settled",
      signature: SIGNATURE,
    });
    expect(getTransaction).toHaveBeenCalledTimes(TRANSACTION_LOOKUP_CONCURRENCY);
  });

  it("stops issuing page lookups once the earliest rejection surfaces", async () => {
    getSignaturesForAddress.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        signature: SIGNATURE,
        slot: 1n,
        blockTime: null,
        err: null,
      }))
    );
    getTransaction
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockImplementation(() => new Promise(() => {}));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).rejects.toThrow("rpc unavailable");
    expect(getTransaction).toHaveBeenCalledTimes(TRANSACTION_LOOKUP_CONCURRENCY);
  });

  it("keeps waiting for the head of history even when a later lookup settles first", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: null },
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    let resolveHead: (value: unknown) => void = () => {};
    getTransaction
      .mockImplementationOnce(
        () =>
          new Promise((resolveGate) => {
            resolveHead = resolveGate;
          })
      )
      .mockResolvedValueOnce(transaction(2));

    const pending = resolveDvpClose(RPC, SWAP, null, CREATED_AT);
    await vi.waitFor(() => expect(getTransaction).toHaveBeenCalledTimes(2));
    resolveHead(transaction(3));

    await expect(pending).resolves.toEqual({
      kind: "resolved",
      status: "cancelled",
      signature: SIGNATURE,
    });
  });

  it("resolves the first close in history order when several candidates close", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 3n, blockTime: null, err: null },
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: null },
    ]);
    getTransaction.mockResolvedValueOnce(transaction(2)).mockResolvedValueOnce(transaction(3));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "settled",
      signature: SIGNATURE,
    });
  });

  it("resolves a close that precedes a create-signature bound in the same page", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: null },
      { signature: CREATE_SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    getTransaction.mockResolvedValue(transaction(2));

    await expect(resolveDvpClose(RPC, SWAP, CREATE_SIGNATURE, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "settled",
      signature: SIGNATURE,
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed transaction fetch when no earlier entry resolved", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: null },
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    getTransaction.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).rejects.toThrow("rpc unavailable");
  });

  it("resolves a close found before a failed fetch in the same page", async () => {
    getSignaturesForAddress.mockResolvedValue([
      { signature: SIGNATURE, slot: 2n, blockTime: null, err: null },
      { signature: SIGNATURE, slot: 1n, blockTime: null, err: null },
    ]);
    getTransaction
      .mockResolvedValueOnce(transaction(2))
      .mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(resolveDvpClose(RPC, SWAP, null, CREATED_AT)).resolves.toEqual({
      kind: "resolved",
      status: "settled",
      signature: SIGNATURE,
    });
  });
});
