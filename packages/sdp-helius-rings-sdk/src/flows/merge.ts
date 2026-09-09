import type { WalletKeys, ZolanaClient } from "@heliuslabs/zolana/client";
import type { Wallet } from "@heliuslabs/zolana/transaction";
import {
  type ApprovalHandler,
  approveIntent,
  buildMergeTransaction,
} from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { type Address, address, type Transaction } from "@solana/kit";
import { protocolMint, requireSpendMint } from "./mint.js";
import { selectMergeNotes } from "./notes.js";

/**
 * Consolidates a wallet's fragmented notes for one asset into a single note.
 *
 * A merge moves no value: it spends 2-5 of the owner's own notes and writes one
 * back worth their sum. That is why it takes no amount and no recipient, and
 * why the wire it produces settles nothing publicly.
 *
 * Unlike the ring builders, this one is handed its inputs rather than choosing
 * them, so the commitments come back for the operation to pin and a rebuild
 * spends the same notes. See `selectMergeNotes` for why SDP selects rather than
 * letting Zolana's auto-selector do it.
 */

export interface MergeDeps {
  readonly client: ZolanaClient;
  readonly wallet: Wallet;
  readonly keys: WalletKeys;
  readonly owner: Address;
}

export interface MergeInput {
  readonly mint: string;
  /** From a previous build of this same operation; binding when present. */
  readonly pinnedInputs?: readonly string[];
}

export interface MergeResult {
  /** Already compiled: the SDK's merge builder assembles its own transaction. */
  readonly transaction: Transaction;
  readonly inputNotes: readonly string[];
}

export async function buildMerge(deps: MergeDeps, input: MergeInput): Promise<MergeResult> {
  requireSpendMint(input.mint, "merge");

  const asset = address(protocolMint(input.mint));
  const selection = selectMergeNotes({
    wallet: deps.wallet,
    asset,
    tree: deps.client.tree,
    ...(input.pinnedInputs ? { pinned: input.pinnedInputs } : {}),
  });

  const transaction = await buildMergeTransaction({
    client: deps.client,
    wallet: deps.wallet,
    keys: deps.keys,
    feePayer: deps.owner,
    asset,
    // Naming the inputs is what stops the SDK auto-selecting up to its padded
    // eight, which the deployed prover refuses.
    inputs: selection.notes.map((note) => note.outputContext.hash),
    approve: bindMergeIntent(asset, selection.notes.length),
  });

  return { transaction, inputNotes: selection.ids };
}

/**
 * Refuses to approve anything but the merge that was selected.
 *
 * The counterpart of `validatePreparedTransferIntent` on the spend path, at the
 * one point a merge exposes before proving: the builder hands its intent to an
 * approval handler, and the receipt it returns is bound to that intent's hash.
 * The merged amount is not checked because nothing chose it — it is whatever
 * the selected notes sum to, and the circuit is what holds it to that.
 */
function bindMergeIntent(asset: Address, numInputs: number): ApprovalHandler {
  return async ({ intent }) => {
    if (intent.kind !== "merge" || intent.asset !== asset || intent.numInputs !== numInputs) {
      throw new HeliusRingsError(
        "conflict",
        "the prepared Rings merge does not match the selected notes"
      );
    }
    return approveIntent(intent);
  };
}
