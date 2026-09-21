/**
 * PRO-1941. What each escrow movement was, from the trade alone: its direction,
 * whether the trade has closed, and where the closing transaction falls.
 */

import type { DvpLegTransferKind, DvpTradeStatus } from "@sdp/types";
import { getBase58Decoder, type Signature, signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deriveDvpLegTransferKinds } from "./leg-transfer-kind";

function sig(n: number): Signature {
  const bytes = new Uint8Array(64);
  bytes[0] = n + 1;
  bytes[63] = 3;
  return signature(getBase58Decoder().decode(bytes));
}

const CLOSE = sig(4);
/** Deposit, reclaim, deposit again, the close, a late deposit, its recovery. */
const HISTORY = [
  { signature: sig(1), direction: "in" },
  { signature: sig(2), direction: "out" },
  { signature: sig(3), direction: "in" },
  { signature: CLOSE, direction: "out" },
  { signature: sig(5), direction: "in" },
  { signature: sig(6), direction: "out" },
] as const;

function kinds(status: DvpTradeStatus, closeSignature: Signature | null): DvpLegTransferKind[] {
  return deriveDvpLegTransferKinds({ status, closeSignature }, HISTORY).map(({ kind }) => kind);
}

describe("deriveDvpLegTransferKinds", () => {
  it.each(["creating", "created", "partially_funded", "funded", "expired"] as const)(
    "names every outflow on a %s trade a reclaim",
    (status) => {
      expect(kinds(status, null)).toEqual([
        "deposit",
        "reclaim",
        "deposit",
        "reclaim",
        "deposit",
        "reclaim",
      ]);
    }
  );

  it.each([
    ["settled", "delivery"],
    ["cancelled", "refund"],
    ["rejected", "refund"],
    ["closed_unknown", "withdrawal"],
    ["create_failed", "withdrawal"],
  ] as const)("names a %s trade's closing outflow a %s", (status, closing) => {
    expect(kinds(status, CLOSE)).toEqual([
      "deposit",
      "reclaim",
      "deposit",
      closing,
      "deposit",
      "recovery",
    ]);
  });

  // Without the closing transaction among the transfers, no outflow can be
  // placed before or after it, so none is given a name it may not have earned.
  it.each([
    ["no close recorded", null],
    ["a close not among the transfers", sig(9)],
  ] as const)("calls a settled trade's outflows withdrawals with %s", (_label, closeSignature) => {
    expect(kinds("settled", closeSignature)).toEqual([
      "deposit",
      "withdrawal",
      "deposit",
      "withdrawal",
      "deposit",
      "withdrawal",
    ]);
  });

  it("keeps each transfer beside its kind, in order", () => {
    const named = deriveDvpLegTransferKinds({ status: "settled", closeSignature: CLOSE }, HISTORY);

    expect(named.map(({ transfer }) => transfer.signature)).toEqual(
      HISTORY.map((entry) => entry.signature)
    );
  });
});
