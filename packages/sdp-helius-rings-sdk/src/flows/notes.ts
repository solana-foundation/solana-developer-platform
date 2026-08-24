import type { Wallet, WalletUtxo } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import type { Address } from "@solana/kit";

/**
 * Choosing which notes a spend consumes, and naming them so the same choice can
 * be reproduced.
 *
 * The naming is the point. A transfer cannot pin its inputs through the SDK's
 * high-level builders, so a rebuild after a lost response is free to select a
 * different set, land alongside the original, and pay the recipient twice.
 * Recording what the first build chose turns a rebuild into a replay: the same
 * notes yield the same nullifiers, and whichever attempt arrives second is
 * rejected by the chain rather than settled.
 */

/**
 * Stable, human-readable name for a note: the hex of its commitment.
 *
 * The commitment rather than the nullifier, because it identifies the note
 * itself independently of who is spending it, and it is what the wallet reports
 * for an unspent note.
 */
export function noteId(note: WalletUtxo): string {
  return Buffer.from(note.outputContext.hash).toString("hex");
}

export interface NoteSelection {
  readonly notes: readonly WalletUtxo[];
  readonly ids: readonly string[];
  readonly total: bigint;
}

export interface SelectNotesInput {
  readonly wallet: Wallet;
  /** The protocol's asset address; native SOL is the system program. */
  readonly asset: Address;
  readonly amount: bigint;
  /** From a previous build of this same operation; binding when present. */
  readonly pinned?: readonly string[];
}

export function selectNotes(input: SelectNotesInput): NoteSelection {
  const available = spendable(input);

  const notes = input.pinned ? repin(available, input.pinned) : cover(available, input.amount);
  const total = notes.reduce((sum, note) => sum + note.utxo.amount, 0n);

  if (total < input.amount) {
    throw new HeliusRingsError(
      "insufficient_balance",
      `the wallet's spendable notes total ${total}, short of ${input.amount}`
    );
  }

  return { notes, ids: notes.map(noteId), total };
}

/**
 * Unspent notes of the requested asset, in a deterministic order.
 *
 * Sorted by commitment rather than left in wallet order: two syncs can return
 * the same notes in different orders, and a selection that depended on that
 * would choose differently on a rebuild for no reason the operator could see.
 */
function spendable(input: SelectNotesInput): readonly WalletUtxo[] {
  return byCommitment(
    input.wallet.utxos().filter((note) => !note.spent && note.utxo.asset === input.asset)
  );
}

function byCommitment(notes: readonly WalletUtxo[]): WalletUtxo[] {
  return [...notes].sort((left, right) => noteId(left).localeCompare(noteId(right)));
}

/**
 * Fewest notes that cover the amount, largest first.
 *
 * Largest-first keeps the input count down, which matters because every input
 * enlarges the proof and the circuit caps how many a transaction may carry.
 * The trade-off is fragmentation — it leaves small notes behind — which is what
 * the merge flow exists to clean up.
 */
function cover(available: readonly WalletUtxo[], amount: bigint): readonly WalletUtxo[] {
  const byValueDesc = [...available].sort((left, right) => {
    if (right.utxo.amount === left.utxo.amount) return 0;
    return right.utxo.amount > left.utxo.amount ? 1 : -1;
  });

  const chosen: WalletUtxo[] = [];
  let total = 0n;
  for (const note of byValueDesc) {
    if (total >= amount) break;
    chosen.push(note);
    total += note.utxo.amount;
  }

  // Back to commitment order, so the inputs a rebuild pins are in the same
  // order the first build recorded them.
  return byCommitment(chosen);
}

/**
 * Re-selects exactly the notes a previous build committed to.
 *
 * A missing note means it has already been spent — most likely by the very
 * attempt this rebuild is trying to recover. Failing here is correct: the
 * operation may already have settled, and choosing replacements would be the
 * double-payment pinning exists to prevent.
 */
function repin(available: readonly WalletUtxo[], pinned: readonly string[]): readonly WalletUtxo[] {
  const byId = new Map(available.map((note) => [noteId(note), note]));
  const missing = pinned.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw new HeliusRingsError(
      "manual_reconciliation_required",
      `${missing.length} of ${pinned.length} pinned notes are no longer spendable; this operation may already have settled`
    );
  }

  return pinned.map((id) => byId.get(id) as WalletUtxo);
}
