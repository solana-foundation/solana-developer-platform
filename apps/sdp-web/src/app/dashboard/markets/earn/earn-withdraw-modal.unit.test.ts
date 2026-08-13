import { describe, expect, it } from "vitest";
import {
  floorUsdToCents,
  laneCeilingFromErrorBody,
  liquidityWriteWins,
} from "./earn-withdraw-modal";

/**
 * The two helpers that carry PRO-1675's provider-quirk handling. Both exist
 * because Ground's sandbox behaviour diverges from its published contract in
 * ways measured on 2026-08-13 — see `packages/sdp-earn/CLAUDE.md` → Conventions.
 */

describe("floorUsdToCents", () => {
  // The reason this function exists: a lane reporting `20.001241` answers 409
  // for `20.001241` and 200 for `20.00`, so `Max` must offer the floored value
  // or it recreates the refused-max bug the ticket removed.
  it("floors the measured Ground case to a fillable amount", () => {
    expect(floorUsdToCents("20.001241")).toBe("20.00");
  });

  it("truncates rather than rounds, so the offer is never above the ceiling", () => {
    // 0.999 must not become 1.00 — that would offer MORE than the provider has.
    expect(floorUsdToCents("0.999")).toBe("0.99");
    expect(floorUsdToCents("19.9999999")).toBe("19.99");
  });

  it("pads short and absent fractions to a well-formed decimal", () => {
    expect(floorUsdToCents("19")).toBe("19.00");
    expect(floorUsdToCents("19.5")).toBe("19.50");
    expect(floorUsdToCents("0")).toBe("0.00");
  });

  it("is exact on values a binary float would mangle", () => {
    // Math.floor(1.005 * 100) / 100 === 1 in IEEE-754; string work gives 1.00
    // for the right reason and keeps the trailing shape the API expects.
    expect(floorUsdToCents("1.005")).toBe("1.00");
    expect(floorUsdToCents("8.115")).toBe("8.11");
    expect(floorUsdToCents("1234567.891234")).toBe("1234567.89");
  });

  it("tolerates surrounding whitespace from a provider string", () => {
    expect(floorUsdToCents(" 20.001241 ")).toBe("20.00");
  });
});

/**
 * The ordering contract for the lane ceiling, replayed as the interleaving that
 * produced the bug (PR #1283 review, greptile P1).
 *
 * Two previews both report `withdrawableUsd`: the on-open liquidity read is
 * undebounced while the amount-specific one waits out PREVIEW_DEBOUNCE_MS, so a
 * reader who types immediately can have the FIRST request resolve LAST. Ground
 * takes ~500ms on this endpoint, so the window is real.
 *
 * Modelled here as a tiny writer over the rule, so the interleavings are
 * explicit. (The rendered behaviour was verified in the browser separately.)
 */
function liquidityWriter() {
  let lastWrittenSeq = 0;
  let value: string | undefined;
  return {
    commit(seq: number, next: string | undefined) {
      if (!liquidityWriteWins(seq, lastWrittenSeq)) return;
      lastWrittenSeq = seq;
      value = next;
    },
    /** A response that carries no figure declines to write at all. */
    declineToWrite(_seq: number) {},
    get current() {
      return value;
    },
  };
}

describe("liquidityWriteWins", () => {
  it("keeps a stale on-open response from overwriting a fresher amount preview", () => {
    const w = liquidityWriter();
    const openSeq = 1; // amount-less read, dispatched first
    const amountSeq = 2; // amount preview, dispatched after the debounce

    // The amount preview comes back first with the current ceiling…
    w.commit(amountSeq, "20.001241");
    // …and the slower on-open read lands afterwards carrying an older figure.
    w.commit(openSeq, "999.00");

    // Without the rule this would read "999.00": Max would offer an amount the
    // provider refuses, or validation would reject one that is currently fine.
    expect(w.current).toBe("20.001241");
  });

  it("lets a later dispatch overwrite an earlier one — the normal case", () => {
    const w = liquidityWriter();
    w.commit(1, "20.00");
    w.commit(2, "18.50");
    expect(w.current).toBe("18.50");
  });

  it("lets the same dispatch write twice: loading, then its own result", () => {
    // The on-open effect commits `loading` and its response under one sequence.
    const w = liquidityWriter();
    w.commit(1, undefined);
    w.commit(1, "20.00");
    expect(w.current).toBe("20.00");
  });

  it("does not let a later EMPTY response veto an earlier real figure", () => {
    // The regression the last-WRITER (not last-dispatch) counter prevents: a
    // failed second request must not strand the line on "checking…".
    const w = liquidityWriter();
    w.declineToWrite(2); // amount preview failed, carries no balance
    w.commit(1, "20.00"); // on-open read lands afterwards with a real figure
    expect(w.current).toBe("20.00");
  });

  it("is a plain dispatch-order comparison", () => {
    expect(liquidityWriteWins(2, 1)).toBe(true);
    expect(liquidityWriteWins(1, 1)).toBe(true);
    expect(liquidityWriteWins(1, 2)).toBe(false);
  });
});

describe("laneCeilingFromErrorBody", () => {
  // The shape actually observed from Ground sandbox through the SDP API.
  const groundConflict = {
    error: {
      code: "CONFLICT",
      message: "ground request failed with status 409",
      details: {
        provider: "ground",
        providerStatus: 409,
        balance: { totalUsd: "20.001241", withdrawableUsd: "20.001241", reservedUsd: "0.000000" },
      },
    },
  };

  it("reads the lane ceiling out of a real 409 envelope", () => {
    expect(laneCeilingFromErrorBody(groundConflict)).toBe("20.001241");
  });

  it("returns undefined for a conflict carrying no balance", () => {
    expect(
      laneCeilingFromErrorBody({
        error: {
          code: "CONFLICT",
          message: "request_id_conflict",
          details: { provider: "ground" },
        },
      })
    ).toBeUndefined();
  });

  it("never throws on a malformed or hostile body", () => {
    for (const body of [
      undefined,
      null,
      "",
      0,
      [],
      {},
      { error: null },
      { error: "boom" },
      { error: { details: null } },
      { error: { details: { balance: "nope" } } },
      { error: { details: { balance: { withdrawableUsd: null } } } },
      // A number here is NOT adopted: the contract is decimal strings, and the
      // API has already normalized. Anything else is a shape we do not know.
      { error: { details: { balance: { withdrawableUsd: 412.5 } } } },
      { error: { details: { balance: { withdrawableUsd: "   " } } } },
    ]) {
      expect(laneCeilingFromErrorBody(body)).toBeUndefined();
    }
  });
});
