import type { Wallet, WalletUtxo } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import type { Address } from "@solana/kit";

/**
 * Chooses which notes a spend consumes and names them, so repeated pre-sign
 * builds of one operation select the same set as the wallet view changes.
 *
 * The name is the commitment rather than the nullifier: it identifies the note
 * independently of who spends it, and it is what the wallet reports for an
 * unspent note.
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

/**
 * Notes one merge may consume. Zolana's circuit is padded to eight, but the
 * deployed prover refuses more than this, so SDP selects its own inputs rather
 * than letting the SDK's auto-selector reach for eight and fail at proving.
 */
export const MERGE_MAX_INPUTS = 5;

/** Below this a merge has nothing to consolidate; the protocol refuses it too. */
const MERGE_MIN_INPUTS = 2;

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

export interface SelectMergeNotesInput {
  readonly wallet: Wallet;
  /** The protocol's asset address; native SOL is the system program. */
  readonly asset: Address;
  /**
   * The tree the merge proves against. Inputs may not span trees, and SDP
   * builds every operation against the one tree its client is configured with.
   */
  readonly tree: Address;
  /** From a previous build of this same operation; binding when present. */
  readonly pinned?: readonly string[];
}

/**
 * Notes a merge consolidates into one.
 *
 * Smallest first, which is the opposite of a spend: a spend wants the fewest
 * inputs that cover an amount, whereas a merge exists to retire the small notes
 * a spend's change keeps producing. Taking the largest notes would consolidate
 * the value that was never fragmented and leave the dust behind.
 */
export function selectMergeNotes(input: SelectMergeNotesInput): NoteSelection {
  const available = spendable(input).filter((note) => note.outputContext.tree === input.tree);

  const notes = input.pinned
    ? repin(available, input.pinned)
    : byCommitment([...available].sort(bySmallestFirst).slice(0, MERGE_MAX_INPUTS));

  if (notes.length < MERGE_MIN_INPUTS) {
    throw new HeliusRingsError(
      "invalid_input",
      `a merge consolidates at least ${MERGE_MIN_INPUTS} notes; this wallet has ${notes.length} for that asset`
    );
  }
  if (notes.length > MERGE_MAX_INPUTS) {
    throw new HeliusRingsError(
      "invalid_input",
      `a merge consolidates at most ${MERGE_MAX_INPUTS} notes; ${notes.length} were selected`
    );
  }

  return { notes, ids: notes.map(noteId), total: notes.reduce((s, n) => s + n.utxo.amount, 0n) };
}

/** Ties broken by commitment so equal-value notes still order deterministically. */
function bySmallestFirst(left: WalletUtxo, right: WalletUtxo): number {
  if (left.utxo.amount === right.utxo.amount) return noteId(left).localeCompare(noteId(right));
  return left.utxo.amount < right.utxo.amount ? -1 : 1;
}

/**
 * Unspent notes of the requested asset, sorted by commitment: two syncs can
 * return the same notes in different orders, and a selection depending on that
 * would choose differently on a rebuild.
 */
function spendable(input: Readonly<{ wallet: Wallet; asset: Address }>): readonly WalletUtxo[] {
  return byCommitment(
    input.wallet
      .utxos()
      // Ring-bound notes are spendable only by their ring's own transact, which
      // these default-pool builders never emit. Selecting one would build a
      // transaction the chain rejects; balances already report them separately.
      .filter(
        (note) => !note.spent && note.utxo.asset === input.asset && note.utxo.ringProgramId == null
      )
  );
}

function byCommitment(notes: readonly WalletUtxo[]): WalletUtxo[] {
  return [...notes].sort((left, right) => noteId(left).localeCompare(noteId(right)));
}

/**
 * Fewest notes that cover the amount, largest first: every input enlarges the
 * proof and the circuit caps how many a transaction may carry. The trade-off is
 * fragmentation, which `selectMergeNotes` cleans up.
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

  // Back to commitment order, matching what the first build recorded.
  return byCommitment(chosen);
}

/**
 * Re-selects exactly the notes a previous build committed to. This runs before
 * signed bytes exist, so a missing note means a stale wallet view rather than a
 * settled operation: refresh and rebuild, but never substitute another note.
 */
function repin(available: readonly WalletUtxo[], pinned: readonly string[]): readonly WalletUtxo[] {
  const byId = new Map(available.map((note) => [noteId(note), note]));
  const missing = pinned.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      "pinned wallet notes are unavailable; refresh wallet state before rebuilding"
    );
  }

  return pinned.map((id) => byId.get(id) as WalletUtxo);
}
