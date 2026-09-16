/**
 * What a broadcast funding transfer did. Reclaim takes a receipt over on this
 * answer and the reconciler deletes one on it, so a wrong "moved nothing" costs
 * a double-funded leg and a wrong "landed" costs a reclaim of money still coming.
 */

import type { SignatureStatusInfo, SolanaRpc } from "@sdp/rpc/solana";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignatureStatuses = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({ getSignatureStatuses }));

const { classifyDvpFundingReceipt, readDvpFundingReceipt } = await import("./funding-receipt");

const RECEIPT =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

function status(overrides: Partial<SignatureStatusInfo>): SignatureStatusInfo {
  return { slot: 5n, confirmations: 1n, confirmationStatus: "confirmed", err: null, ...overrides };
}

describe("classifyDvpFundingReceipt", () => {
  it("calls a confirmed success landed", () => {
    expect(classifyDvpFundingReceipt(status({}), false)).toBe("landed");
    expect(classifyDvpFundingReceipt(status({ confirmationStatus: "finalized" }), true)).toBe(
      "landed"
    );
  });

  it("calls a confirmed failure moved-nothing: fees paid, no tokens moved", () => {
    expect(
      classifyDvpFundingReceipt(status({ err: { InstructionError: [0, { Custom: 1 }] } }), false)
    ).toBe("moved_nothing");
  });

  // A processed transaction can still be dropped or re-executed with its fork.
  it("waits on a processed transaction either way", () => {
    expect(classifyDvpFundingReceipt(status({ confirmationStatus: "processed" }), true)).toBe(
      "pending"
    );
    expect(
      classifyDvpFundingReceipt(
        status({ confirmationStatus: "processed", err: { InstructionError: [0, { Custom: 1 }] } }),
        true
      )
    ).toBe("pending");
  });

  it("calls an unseen transaction pending until its blockhash expires, then moved-nothing", () => {
    expect(classifyDvpFundingReceipt(null, false)).toBe("pending");
    expect(classifyDvpFundingReceipt(null, true)).toBe("moved_nothing");
  });
});

describe("readDvpFundingReceipt", () => {
  const send = vi.fn();
  // SAFETY: readDvpFundingReceipt calls only getBlockHeight(...).send() on the
  // RPC itself; the status read goes through the mocked @sdp/rpc helper.
  const rpc = { getBlockHeight: () => ({ send }) } as unknown as SolanaRpc;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Height first: past expiry nothing can land after it, so the status read
  // that follows is final. The other order leaves a gap to land in.
  it("reads the block height before the status", async () => {
    send.mockResolvedValue(95n);
    getSignatureStatuses.mockResolvedValue([null]);

    await expect(
      readDvpFundingReceipt(rpc, { fundingTx: RECEIPT, expiryHeight: "90" })
    ).resolves.toBe("moved_nothing");
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      getSignatureStatuses.mock.invocationCallOrder[0]
    );
    expect(getSignatureStatuses).toHaveBeenCalledWith(rpc, [RECEIPT], {
      searchTransactionHistory: true,
    });
  });

  it("keeps an unseen transaction pending at its last valid height", async () => {
    send.mockResolvedValue(90n);
    getSignatureStatuses.mockResolvedValue([null]);

    await expect(
      readDvpFundingReceipt(rpc, { fundingTx: RECEIPT, expiryHeight: "90" })
    ).resolves.toBe("pending");
  });

  // A failed read is not an answer. The caller must treat the receipt as live.
  it("throws when the chain cannot be read", async () => {
    send.mockRejectedValue(new Error("429"));

    await expect(
      readDvpFundingReceipt(rpc, { fundingTx: RECEIPT, expiryHeight: "90" })
    ).rejects.toThrow("429");
  });
});
