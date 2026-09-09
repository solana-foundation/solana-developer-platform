import type { Wallet, WalletUtxo } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { noteId, selectNotes } from "./notes.js";

/**
 * These tests are about one property: two builds of the same operation must
 * spend the same notes. Everything else here supports proving that.
 */

const SOL: Address = address("11111111111111111111111111111111");
const USDC: Address = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

/** A note is identified by its commitment, so that is what the fake varies. */
function note(commitment: number, amount: bigint, asset: Address = SOL, spent = false): WalletUtxo {
  return {
    utxo: { asset, amount } as WalletUtxo["utxo"],
    outputContext: {
      hash: new Uint8Array([commitment]) as WalletUtxo["outputContext"]["hash"],
      tree: SOL,
      leafIndex: 0n,
    },
    nullifier: new Uint8Array([commitment]) as WalletUtxo["nullifier"],
    spent,
  };
}

function walletOf(notes: readonly WalletUtxo[]): Wallet {
  return { utxos: () => notes } as unknown as Wallet;
}

describe("selectNotes", () => {
  it("covers the amount with the fewest notes", async () => {
    const wallet = walletOf([note(1, 100n), note(2, 500n), note(3, 50n)]);

    const selection = selectNotes({ wallet, asset: SOL, amount: 400n });

    // Largest-first: every extra input enlarges the proof, and the circuit caps
    // how many a transaction may carry.
    expect(selection.notes).toHaveLength(1);
    expect(selection.total).toBe(500n);
  });

  it("adds notes until the amount is covered", async () => {
    const wallet = walletOf([note(1, 100n), note(2, 100n), note(3, 100n)]);

    const selection = selectNotes({ wallet, asset: SOL, amount: 250n });

    expect(selection.notes).toHaveLength(3);
    expect(selection.total).toBe(300n);
  });

  it("selects the same notes twice for the same request", async () => {
    // Same notes, different order: two syncs can report them either way.
    const forward = walletOf([note(1, 100n), note(2, 100n), note(3, 100n)]);
    const reversed = walletOf([note(3, 100n), note(2, 100n), note(1, 100n)]);

    // The property the pinning design rests on. Wallet ordering must not make
    // repeated pre-sign builds choose different inputs.
    expect(selectNotes({ wallet: forward, asset: SOL, amount: 150n }).ids).toEqual(
      selectNotes({ wallet: reversed, asset: SOL, amount: 150n }).ids
    );
  });

  it("ignores spent notes and notes of another asset", async () => {
    const wallet = walletOf([note(1, 900n, SOL, true), note(2, 900n, USDC), note(3, 100n, SOL)]);

    const selection = selectNotes({ wallet, asset: SOL, amount: 100n });

    expect(selection.ids).toEqual([noteId(note(3, 100n))]);
  });

  it("refuses when the spendable notes do not cover the amount", async () => {
    const wallet = walletOf([note(1, 100n), note(2, 100n, SOL, true)]);

    const error = await Promise.resolve()
      .then(() => selectNotes({ wallet, asset: SOL, amount: 150n }))
      .then(
        () => null,
        (thrown: unknown) => thrown
      );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("insufficient_balance");
  });

  describe("pinned inputs", () => {
    it("spends exactly what a previous build committed to", async () => {
      const wallet = walletOf([note(1, 100n), note(2, 900n), note(3, 100n)]);
      const pinned = [noteId(note(1, 100n)), noteId(note(3, 100n))];

      const selection = selectNotes({ wallet, asset: SOL, amount: 150n, pinned });

      // Not the note that would cover it alone. A rebuild is a replay, not a
      // fresh decision.
      expect(selection.ids).toEqual(pinned);
      expect(selection.total).toBe(200n);
    });

    it("retries sync when a pre-sign pinned note is absent", async () => {
      const wallet = walletOf([note(1, 100n, SOL, true), note(2, 900n)]);

      const error = await Promise.resolve()
        .then(() =>
          selectNotes({
            wallet,
            asset: SOL,
            amount: 100n,
            pinned: [noteId(note(1, 100n))],
          })
        )
        .then(
          () => null,
          (thrown: unknown) => thrown
        );

      // Builds run before signed bytes are persisted, so this cannot be evidence
      // that this attempt settled. A refreshed indexer view may restore the note.
      expect(error).toMatchObject({
        code: "gateway_unavailable",
        message: "pinned wallet notes are unavailable; refresh wallet state before rebuilding",
      });
    });

    it("still refuses if the pinned notes no longer cover the amount", async () => {
      const wallet = walletOf([note(1, 10n)]);

      const error = await Promise.resolve()
        .then(() =>
          selectNotes({ wallet, asset: SOL, amount: 100n, pinned: [noteId(note(1, 10n))] })
        )
        .then(
          () => null,
          (thrown: unknown) => thrown
        );

      expect((error as HeliusRingsError).code).toBe("insufficient_balance");
    });
  });
});
