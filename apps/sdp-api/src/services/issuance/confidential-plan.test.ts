import type { MosaicTransactionResult } from "@sdp/issuance/mosaic/types";
import { MosaicTransactionPlanError } from "@sdp/issuance/mosaic/types";
import { describe, expect, it } from "vitest";
import {
  planSignatureFields,
  summarizeConfidentialSettlement,
  toSubmittedList,
} from "./confidential-plan";

const result = (signature: string, slot: bigint): MosaicTransactionResult => ({ signature, slot });

describe("toSubmittedList", () => {
  it("wraps a single-transaction result", () => {
    const single = result("sig_a", 1n);
    expect(toSubmittedList(single)).toEqual([single]);
  });

  it("preserves plan order", () => {
    const plan = { transactions: [result("setup", 1n), result("op", 2n), result("cleanup", 3n)] };
    expect(toSubmittedList(plan).map((entry) => entry.signature)).toEqual([
      "setup",
      "op",
      "cleanup",
    ]);
  });
});

describe("summarizeConfidentialSettlement", () => {
  // The operation's effect lands in the last transaction; the ones around it only
  // create and tear down proof context state, so settling on the first would
  // record evidence for a transaction that did not do the thing.
  it("settles a plan on its last transaction", () => {
    const settlement = summarizeConfidentialSettlement({
      transactions: [result("setup", 10n), result("op", 11n), result("cleanup", 12n)],
    });
    expect(settlement).toEqual({
      signature: "cleanup",
      slot: 12n,
      planSignatures: ["setup", "op", "cleanup"],
    });
  });

  it("settles a single transaction on itself", () => {
    expect(summarizeConfidentialSettlement(result("sig_only", 7n))).toEqual({
      signature: "sig_only",
      slot: 7n,
      planSignatures: ["sig_only"],
    });
  });

  // A plan that submitted nothing would otherwise settle the row against
  // `undefined` and report success for an operation that never ran.
  it("returns null rather than settling an empty plan", () => {
    expect(summarizeConfidentialSettlement({ transactions: [] })).toBeNull();
  });
});

describe("planSignatureFields", () => {
  it("journals every signature for a multi-transaction plan", () => {
    expect(
      planSignatureFields({ signature: "c", slot: 3n, planSignatures: ["a", "b", "c"] })
    ).toEqual({ planSignatures: ["a", "b", "c"] });
  });

  // A single-transaction operation already records its signature on the row; a
  // one-element planSignatures array would be noise in every freeze-shaped op.
  it("omits the field entirely for a single transaction", () => {
    expect(planSignatureFields({ signature: "a", slot: 1n, planSignatures: ["a"] })).toEqual({});
  });
});

describe("MosaicTransactionPlanError", () => {
  // A plan that fails partway has already landed transactions that cannot be
  // rolled back. Their signatures are the only handle on the proof context-state
  // accounts they created, so they must survive the throw.
  it("carries the transactions that already landed", () => {
    const cause = new Error("blockhash expired");
    const error = new MosaicTransactionPlanError(cause, [result("setup", 1n), result("op", 2n)]);

    expect(error.message).toBe("blockhash expired");
    expect(error.cause).toBe(cause);
    expect(error.submitted.map((entry) => entry.signature)).toEqual(["setup", "op"]);
  });

  it("reports an empty list when the first transaction failed", () => {
    expect(new MosaicTransactionPlanError(new Error("nope"), []).submitted).toEqual([]);
  });
});
