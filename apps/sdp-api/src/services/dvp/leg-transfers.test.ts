/**
 * Reading a leg escrow's transfers off the chain (PRO-1941).
 *
 * Three contracts. The delta: a balance change is read from the escrow's own
 * pre and post token balances, and anything that does not add up is unreadable,
 * never zero. The read position: it only ever moves over signatures that were
 * resolved and finalized, so a failed read, a transaction the cluster has not
 * served yet, a spent budget or a provisional signature leaves the next sweep to
 * carry on from there. The ledger: a provisional row whose transaction the
 * cluster dropped is removed, and history older than the trade is never read.
 */

import {
  type Address,
  address,
  getBase58Decoder,
  type Signature,
  signature,
  stringifiedBigInt,
  stringifiedNumber,
  type TokenBalance,
  unixTimestamp,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DvpLegTransfer,
  DvpLegTransferRepository,
  DvpLegTransferScan,
} from "@/db/repositories/dvp-leg-transfer.repository";
import {
  type DvpEscrowHistoryEntry,
  type DvpEscrowHistoryReader,
  type DvpLegEscrow,
  type DvpLegTransaction,
  HISTORY_PAGE_LIMIT,
  parseDvpLegTransaction,
  readDvpLegTransfer,
  syncDvpLegTransfers,
} from "./leg-transfers";

const ESCROW = address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU");
const MINT = address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
const FEE_PAYER = address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY");
const DEPOSITOR = address("AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** 2026-09-10T00:00:00Z, when the trade row was created. */
const CREATED_AT_SECONDS = 1_789_000_000;
const LEG: DvpLegEscrow = {
  tradeId: "dvp_ledger",
  side: "a",
  escrow: ESCROW,
  mint: MINT,
  createdAt: new Date(CREATED_AT_SECONDS * 1000).toISOString(),
};

/** A distinct, structurally valid signature per number. */
function sig(n: number): Signature {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  bytes[63] = 7;
  return signature(getBase58Decoder().decode(bytes));
}

function balance(accountIndex: number, amount: string, mint: Address = MINT): TokenBalance {
  return {
    accountIndex,
    mint,
    owner: DEPOSITOR,
    programId: TOKEN_2022,
    uiTokenAmount: {
      amount: stringifiedBigInt(amount),
      decimals: 6,
      uiAmount: null,
      uiAmountString: stringifiedNumber(amount),
    },
  };
}

/**
 * A transaction touching the fee payer (0), a depositor account (1) and the
 * escrow (2), with the escrow's balances as given.
 */
function transaction(
  escrow: { pre?: string; post?: string },
  overrides: Partial<DvpLegTransaction> = {}
): DvpLegTransaction {
  return {
    slot: 420n,
    blockTime: unixTimestamp(BigInt(CREATED_AT_SECONDS)),
    meta: {
      err: null,
      preTokenBalances: escrow.pre === undefined ? [] : [balance(2, escrow.pre)],
      postTokenBalances: escrow.post === undefined ? [] : [balance(2, escrow.post)],
    },
    transaction: {
      message: { accountKeys: [{ pubkey: FEE_PAYER }, { pubkey: DEPOSITOR }, { pubkey: ESCROW }] },
    },
    ...overrides,
  };
}

describe("readDvpLegTransfer", () => {
  it("reads a deposit as the rise in the escrow's balance", () => {
    expect(
      readDvpLegTransfer(sig(1), transaction({ pre: "400", post: "1000" }), LEG, false)
    ).toEqual({
      kind: "transfer",
      transfer: {
        tradeId: "dvp_ledger",
        side: "a",
        signature: sig(1),
        direction: "in",
        amount: "600",
        slot: "420",
        blockTime: String(CREATED_AT_SECONDS),
        feePayer: FEE_PAYER,
        finalized: false,
      },
    });
  });

  // The escrow created in the same transaction that funds it has no pre balance.
  it("reads an escrow created in the transaction as starting from zero", () => {
    const reading = readDvpLegTransfer(sig(1), transaction({ post: "1000" }), LEG, true);

    expect(reading).toMatchObject({
      kind: "transfer",
      transfer: { direction: "in", amount: "1000", finalized: true },
    });
  });

  // Settle and cancel empty the escrow and close it in one transaction.
  it("reads an escrow closed in the transaction as ending at zero", () => {
    const reading = readDvpLegTransfer(sig(1), transaction({ pre: "1000" }), LEG, true);

    expect(reading).toMatchObject({
      kind: "transfer",
      transfer: { direction: "out", amount: "1000" },
    });
  });

  it("keeps the block time null when the cluster recorded none", () => {
    const reading = readDvpLegTransfer(
      sig(1),
      transaction({ pre: "0", post: "5" }, { blockTime: null }),
      LEG,
      true
    );

    expect(reading).toMatchObject({ kind: "transfer", transfer: { blockTime: null } });
  });

  it("records nothing for a failed transaction", () => {
    const failed = transaction({ pre: "0", post: "1000" });
    const reading = readDvpLegTransfer(
      sig(1),
      {
        ...failed,
        meta: failed.meta && { ...failed.meta, err: { InstructionError: [0, { Custom: 1 }] } },
      },
      LEG,
      true
    );

    expect(reading).toEqual({ kind: "none" });
  });

  it("records nothing for a transaction that loads the escrow without moving its tokens", () => {
    expect(
      readDvpLegTransfer(sig(1), transaction({ pre: "1000", post: "1000" }), LEG, true)
    ).toEqual({ kind: "none" });
    expect(readDvpLegTransfer(sig(2), transaction({}), LEG, true)).toEqual({ kind: "none" });
  });

  it.each([
    ["no status metadata", transaction({ pre: "0", post: "1" }, { meta: null })],
    [
      "no token balances",
      transaction({}, { meta: { err: null, preTokenBalances: undefined, postTokenBalances: [] } }),
    ],
    [
      "the escrow missing from its accounts",
      transaction(
        { pre: "0", post: "1" },
        { transaction: { message: { accountKeys: [{ pubkey: FEE_PAYER }] } } }
      ),
    ],
    [
      "a fee payer that is not an address",
      transaction(
        { pre: "0", post: "1" },
        {
          transaction: {
            message: {
              accountKeys: [{ pubkey: "nope" }, { pubkey: DEPOSITOR }, { pubkey: ESCROW }],
            },
          },
        }
      ),
    ],
    [
      "a balance for another mint",
      transaction(
        {},
        {
          meta: {
            err: null,
            preTokenBalances: [],
            postTokenBalances: [balance(2, "1000", DEPOSITOR)],
          },
        }
      ),
    ],
    [
      "a negative balance",
      transaction(
        {},
        { meta: { err: null, preTokenBalances: [], postTokenBalances: [balance(2, "-5")] } }
      ),
    ],
  ])("never reads a transaction with %s as zero", (_label, unreadable) => {
    expect(readDvpLegTransfer(sig(1), unreadable, LEG, true)).toMatchObject({
      kind: "unreadable",
    });
  });
});

describe("parseDvpLegTransaction", () => {
  it("decodes a served transaction", () => {
    expect(parseDvpLegTransaction(transaction({ pre: "0", post: "1" }))).toMatchObject({
      kind: "read",
      transaction: { slot: 420n },
    });
  });

  // Null from getTransaction is a transaction not served yet, not one that
  // moved nothing: the read stops there rather than passing over it.
  it("reads null as not served yet", () => {
    expect(parseDvpLegTransaction(null)).toEqual({ kind: "not_served" });
  });

  it.each([
    ["a slot that is not a u64", { ...transaction({ pre: "0", post: "1" }), slot: "420" }],
    ["a block time that is not a timestamp", { ...transaction({}), blockTime: "yesterday" }],
    [
      "an error that is neither null nor a transaction error",
      { ...transaction({}), meta: { err: 5 } },
    ],
    ["no transaction at all", "not a transaction"],
  ])("never decodes a response with %s", (_label, response) => {
    expect(parseDvpLegTransaction(response)).toMatchObject({ kind: "malformed" });
  });
});

describe("syncDvpLegTransfers", () => {
  /** The ledger, keyed by signature, as the fake repository holds it. */
  const rows = new Map<Signature, DvpLegTransfer>();
  const saved: DvpLegTransferScan[] = [];
  const deleted: Signature[] = [];
  const transfers: DvpLegTransferRepository = {
    record: async (transfer) => {
      const existing = rows.get(transfer.signature);
      rows.set(transfer.signature, {
        // The ledger assigns the place in the leg's history; here it is the
        // order the walk recorded them in, which is what the real INSERT does.
        sequence: String(rows.size + 1),
        ...(existing ?? transfer),
        finalized: (existing?.finalized ?? false) || transfer.finalized,
      });
    },
    markFinalized: async (_tradeId, _side, finalizedSignature) => {
      const existing = rows.get(finalizedSignature);
      if (existing !== undefined) {
        rows.set(finalizedSignature, { ...existing, finalized: true });
      }
    },
    deleteProvisional: async (_tradeId, _side, droppedSignature) => {
      if (rows.get(droppedSignature)?.finalized === false) {
        rows.delete(droppedSignature);
        deleted.push(droppedSignature);
      }
    },
    listForLeg: async () => [...rows.values()],
    listForTrades: async () => new Map(),
    listScans: async () => [],
    saveScan: async (_tradeId, scan) => {
      saved.push(scan);
    },
  };

  const served = new Map<Signature, DvpLegTransaction | null | Error | "malformed">();
  /** An answer the fake cluster gives, decoded as the real reader would. */
  const listSignatures = vi.fn<DvpEscrowHistoryReader["listSignatures"]>();
  const readTransaction = vi.fn<DvpEscrowHistoryReader["readTransaction"]>(async (requested) => {
    const answer = served.get(requested);
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer === undefined) {
      throw new Error(`the test served nothing for ${requested}`);
    }
    if (answer === "malformed") {
      return { kind: "malformed", reason: "the transaction does not have the expected shape" };
    }
    return answer === null ? { kind: "not_served" } : { kind: "read", transaction: answer };
  });
  const knowsSignatures = vi.fn<DvpEscrowHistoryReader["knowsSignatures"]>();
  // The node holds the whole of this trade's history unless a test says otherwise.
  const oldestKnownSlot = vi.fn<DvpEscrowHistoryReader["oldestKnownSlot"]>(async () => 0n);
  const reader: DvpEscrowHistoryReader = {
    listSignatures,
    readTransaction,
    knowsSignatures,
    oldestKnownSlot,
  };

  /** History entries, newest first, as the RPC lists them; finalized unless said otherwise. */
  function history(
    numbers: readonly number[],
    overrides: Partial<DvpEscrowHistoryEntry> = {}
  ): DvpEscrowHistoryEntry[] {
    return numbers.map((n) => ({
      signature: sig(n),
      slot: BigInt(n),
      blockTime: unixTimestamp(BigInt(CREATED_AT_SECONDS + n)),
      failed: false,
      finalized: true,
      ...overrides,
    }));
  }

  function recordedRow(n: number, finalized: boolean): DvpLegTransfer {
    return {
      sequence: String(n),
      tradeId: LEG.tradeId,
      side: LEG.side,
      signature: sig(n),
      direction: "in",
      amount: "5",
      slot: String(n),
      blockTime: String(CREATED_AT_SECONDS + n),
      feePayer: FEE_PAYER,
      finalized,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    saved.length = 0;
    deleted.length = 0;
    served.clear();
  });

  it("records a first read oldest first and remembers the newest signature", async () => {
    listSignatures.mockResolvedValueOnce(history([3, 2, 1]));
    served.set(sig(1), transaction({ post: "400" }));
    served.set(sig(2), transaction({ pre: "400", post: "400" }));
    served.set(sig(3), transaction({ pre: "400", post: "1000" }));

    const count = await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

    expect(count).toBe(2);
    expect([...rows.values()].map((row) => [row.signature, row.amount, row.finalized])).toEqual([
      [sig(1), "400", true],
      [sig(3), "600", true],
    ]);
    expect(listSignatures).toHaveBeenCalledWith(ESCROW, { before: null, until: null });
    expect(saved).toEqual([
      { side: "a", cursor: { signature: sig(3), slot: "3" }, scannedAt: expect.any(String) },
    ]);
  });

  it("pages back to the last position with before and until", async () => {
    const fullPage = history(
      Array.from({ length: HISTORY_PAGE_LIMIT }, (_, index) => 2_000 - index),
      // Failed transactions need no read, which keeps this test to the paging.
      { failed: true }
    );
    listSignatures.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);

    await syncDvpLegTransfers(
      reader,
      transfers,
      LEG,
      {
        side: "a",
        cursor: { signature: sig(5), slot: "5" },
        scannedAt: "2026-09-15T00:00:00.000Z",
      },
      { remaining: 10 }
    );

    expect(listSignatures.mock.calls.map(([, page]) => page)).toEqual([
      { before: null, until: sig(5) },
      { before: sig(1_001), until: sig(5) },
    ]);
    expect(readTransaction).not.toHaveBeenCalled();
    expect(saved[0]?.cursor).toEqual({ signature: sig(2_000), slot: "2000" });
  });

  // An escrow address can outlive a trade. What happened there before this
  // trade existed is not this trade's history.
  it("reads no further back than the trade's creation, less the create clock skew", async () => {
    listSignatures.mockResolvedValueOnce([
      ...history([2]),
      // Four minutes before the row: inside the skew the close lookup allows.
      ...history([1], { blockTime: unixTimestamp(BigInt(CREATED_AT_SECONDS - 240)) }),
      // An hour before: a previous life of the address.
      ...history([0], { blockTime: unixTimestamp(BigInt(CREATED_AT_SECONDS - 3_600)) }),
    ]);
    served.set(sig(1), transaction({ post: "10" }));
    served.set(sig(2), transaction({ pre: "10", post: "30" }));

    await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

    expect(readTransaction.mock.calls.map(([requested]) => requested)).toEqual([sig(1), sig(2)]);
    expect(listSignatures).toHaveBeenCalledTimes(1);
  });

  // Resolving the oldest of a truncated read would leave a gap behind the
  // position that no later read could fill.
  it("reads nothing and keeps its position when the history exceeds the scan cap", async () => {
    listSignatures.mockResolvedValue(
      history(Array.from({ length: HISTORY_PAGE_LIMIT }, (_, index) => index))
    );

    const count = await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

    expect(count).toBe(0);
    expect(listSignatures).toHaveBeenCalledTimes(3);
    expect(readTransaction).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("records nothing and saves nothing when listing the history fails mid-page", async () => {
    listSignatures
      .mockResolvedValueOnce(history(Array.from({ length: HISTORY_PAGE_LIMIT }, (_, i) => 900 - i)))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await expect(
      syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 })
    ).rejects.toThrow("429");

    expect(readTransaction).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
    expect(saved).toEqual([]);
  });

  it("stops at a failed read, keeping everything before it and nothing after", async () => {
    listSignatures.mockResolvedValueOnce(history([3, 2, 1]));
    served.set(sig(1), transaction({ post: "400" }));
    served.set(sig(2), new Error("socket hang up"));
    served.set(sig(3), transaction({ pre: "400", post: "1000" }));

    await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

    expect([...rows.keys()]).toEqual([sig(1)]);
    // Not a complete read, so the leg stays due for the next sweep.
    expect(saved).toEqual([
      { side: "a", cursor: { signature: sig(1), slot: "1" }, scannedAt: null },
    ]);
  });

  it("stops at a transaction the cluster does not serve yet", async () => {
    listSignatures.mockResolvedValueOnce(history([2, 1]));
    served.set(sig(1), null);
    served.set(sig(2), transaction({ post: "1" }));

    await syncDvpLegTransfers(
      reader,
      transfers,
      LEG,
      { side: "a", cursor: null, scannedAt: "2026-09-15T00:00:00.000Z" },
      { remaining: 10 }
    );

    expect(rows.size).toBe(0);
    expect(saved).toEqual([{ side: "a", cursor: null, scannedAt: null }]);
  });

  it("skips an unreadable transaction without recording it, and moves past it", async () => {
    listSignatures.mockResolvedValueOnce(history([3, 2, 1]));
    served.set(sig(1), transaction({ post: "400" }, { meta: null }));
    served.set(sig(2), "malformed");
    served.set(sig(3), transaction({ post: "1000" }));

    await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

    expect([...rows.values()].map((row) => [row.signature, row.amount])).toEqual([
      [sig(3), "1000"],
    ]);
    expect(saved[0]?.cursor?.signature).toBe(sig(3));
  });

  it("shares the sweep's budget and leaves the rest for the next sweep", async () => {
    listSignatures.mockResolvedValueOnce(history([3, 2, 1]));
    for (const n of [1, 2, 3]) {
      served.set(sig(n), transaction({ pre: String(n - 1), post: String(n) }));
    }
    const budget = { remaining: 2 };

    await syncDvpLegTransfers(reader, transfers, LEG, null, budget);

    expect(budget.remaining).toBe(0);
    expect([...rows.keys()]).toEqual([sig(1), sig(2)]);
    expect(saved).toEqual([
      { side: "a", cursor: { signature: sig(2), slot: "2" }, scannedAt: null },
    ]);
  });

  describe("confirmed, not yet finalized", () => {
    it("records a confirmed transfer provisionally and keeps the position behind it", async () => {
      listSignatures.mockResolvedValueOnce([
        ...history([2], { finalized: false }),
        ...history([1]),
      ]);
      served.set(sig(1), transaction({ post: "400" }));
      served.set(sig(2), transaction({ pre: "400", post: "1000" }));

      await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

      expect(rows.get(sig(2))?.finalized).toBe(false);
      expect(saved).toEqual([
        { side: "a", cursor: { signature: sig(1), slot: "1" }, scannedAt: null },
      ]);
    });

    // Past a provisional signature, a finalized one cannot move the position:
    // everything behind the cursor must be settled.
    it("never moves the position past a provisional signature", async () => {
      listSignatures.mockResolvedValueOnce([
        ...history([3]),
        ...history([2], { finalized: false }),
        ...history([1]),
      ]);
      for (const n of [1, 2, 3]) {
        served.set(sig(n), transaction({ pre: String(n - 1), post: String(n) }));
      }

      await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

      expect(rows.size).toBe(3);
      expect(saved[0]?.cursor).toEqual({ signature: sig(1), slot: "1" });
    });

    it("finalizes a provisional row without reading its transaction again", async () => {
      rows.set(sig(2), recordedRow(2, false));
      listSignatures.mockResolvedValueOnce(history([2]));

      await syncDvpLegTransfers(
        reader,
        transfers,
        LEG,
        { side: "a", cursor: { signature: sig(1), slot: "1" }, scannedAt: null },
        { remaining: 10 }
      );

      expect(readTransaction).not.toHaveBeenCalled();
      expect(knowsSignatures).not.toHaveBeenCalled();
      expect(rows.get(sig(2))?.finalized).toBe(true);
      expect(saved).toEqual([
        { side: "a", cursor: { signature: sig(2), slot: "2" }, scannedAt: expect.any(String) },
      ]);
    });

    it("removes a provisional row whose transaction the cluster dropped", async () => {
      rows.set(sig(2), recordedRow(2, false));
      listSignatures.mockResolvedValueOnce([]);
      knowsSignatures.mockResolvedValueOnce([false]);

      await syncDvpLegTransfers(
        reader,
        transfers,
        LEG,
        { side: "a", cursor: { signature: sig(1), slot: "1" }, scannedAt: null },
        { remaining: 10 }
      );

      expect(knowsSignatures).toHaveBeenCalledWith([sig(2)]);
      expect(deleted).toEqual([sig(2)]);
      expect(saved).toEqual([
        { side: "a", cursor: { signature: sig(1), slot: "1" }, scannedAt: expect.any(String) },
      ]);
    });

    // A lagging node can list less than the cluster holds. Only the chain's
    // definitive "not found" deletes, and a failed lookup deletes nothing.
    it.each([
      ["the cluster still knows it", () => knowsSignatures.mockResolvedValueOnce([true])],
      [
        // Below the node's own history "not found" is the node's gap, and a
        // deletion there would drop a transfer nothing later brings back.
        "the node's history starts after it",
        () => {
          knowsSignatures.mockResolvedValueOnce([false]);
          oldestKnownSlot.mockResolvedValueOnce(1_000_000n);
        },
      ],
      [
        "how far back the node goes cannot be read",
        () => {
          knowsSignatures.mockResolvedValueOnce([false]);
          oldestKnownSlot.mockRejectedValueOnce(new Error("getFirstAvailableBlock failed"));
        },
      ],
      [
        "the lookup fails",
        () => knowsSignatures.mockRejectedValueOnce(new Error("getSignatureStatuses short")),
      ],
    ])("keeps an unlisted provisional row when %s", async (_label, arrange) => {
      rows.set(sig(2), recordedRow(2, false));
      listSignatures.mockResolvedValueOnce([]);
      arrange();

      await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

      expect(deleted).toEqual([]);
      expect(rows.has(sig(2))).toBe(true);
      // Still unaccounted for, so the next sweep asks again.
      expect(saved[0]?.scannedAt).toBeNull();
    });

    it("never asks about a finalized row, listed or not", async () => {
      rows.set(sig(2), recordedRow(2, true));
      listSignatures.mockResolvedValueOnce([]);

      await syncDvpLegTransfers(reader, transfers, LEG, null, { remaining: 10 });

      expect(knowsSignatures).not.toHaveBeenCalled();
      expect(rows.has(sig(2))).toBe(true);
    });
  });
});
