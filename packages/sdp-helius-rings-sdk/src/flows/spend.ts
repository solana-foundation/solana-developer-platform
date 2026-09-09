import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { WalletKeys, ZolanaClient } from "@heliuslabs/zolana/client";
import { transactInstruction } from "@heliuslabs/zolana/interface";
import {
  ConfidentialTransfer,
  type EncryptedTransfer,
  encryptConfidentialTransfer,
  ProofInputUtxo,
  type Wallet,
  WithdrawalTarget,
} from "@heliuslabs/zolana/transaction";
import { type Address, address, type Instruction } from "@solana/kit";
import { type PreparedSpendIntent, validatePreparedTransferIntent } from "../intent-validation.js";
import { protocolMint, requireProtocolSol } from "./mint.js";
import { type NoteSelection, selectNotes } from "./notes.js";

export interface SpendDeps {
  readonly client: ZolanaClient;
  readonly wallet: Wallet;
  readonly keys: WalletKeys;
  readonly owner: Address;
}

export interface SpendResult {
  readonly instructions?: readonly Instruction[];
  readonly inputNotes: readonly string[];
}

export interface WithdrawInput {
  readonly recipient: string;
  readonly mint: string;
  readonly amountRaw: string;
  readonly pinnedInputs?: readonly string[];
}

export interface TransferInput {
  /** Full recipient shielded address; caller loaded the recipient's material to obtain it. */
  readonly recipient: ShieldedAddress;
  readonly mint: string;
  readonly amountRaw: string;
  readonly pinnedInputs?: readonly string[];
}

export async function buildWithdrawal(deps: SpendDeps, input: WithdrawInput): Promise<SpendResult> {
  requireProtocolSol(input.mint, "withdrawal");

  const recipient = address(input.recipient);
  const { asset, amount, selection, transfer: withdrawal } = arm(deps, input);

  const target = WithdrawalTarget.sol({ recipient });
  withdrawal.withdraw(asset, amount, target);

  return {
    instructions: [
      transactInstruction({
        payer: deps.owner,
        inputTree: deps.client.tree,
        outputTree: deps.client.tree,
        withdrawal: target,
        data: await prove(deps, withdrawal, {
          kind: "withdraw",
          owner: deps.owner,
          recipient,
          amount,
        }),
      }),
    ],
    inputNotes: selection.ids,
  };
}

/**
 * Shielded → shielded transfer. Same note-selection + proving path as a
 * withdraw, but the confidential transfer's `.send()` names a shielded recipient
 * instead of a public settlement target. No interface transfer on the outer tx.
 */
export async function buildTransfer(deps: SpendDeps, input: TransferInput): Promise<SpendResult> {
  requireProtocolSol(input.mint, "transfer");

  const { asset, amount, selection, transfer } = arm(deps, input);
  transfer.send(input.recipient, asset, amount);

  return {
    instructions: [
      transactInstruction({
        payer: deps.owner,
        inputTree: deps.client.tree,
        outputTree: deps.client.tree,
        data: await prove(deps, transfer, {
          kind: "transfer_registered",
          owner: deps.owner,
          recipient: input.recipient,
          asset,
          amount,
        }),
      }),
    ],
    inputNotes: selection.ids,
  };
}

/**
 * Selects the notes and opens a confidential transfer over them. Everything up
 * to this point is common to both spends; only the call that arms the transfer
 * — `withdraw` to a public target, or `send` to a shielded address — differs.
 */
function arm(
  deps: SpendDeps,
  input: Readonly<{ mint: string; amountRaw: string; pinnedInputs?: readonly string[] }>
) {
  const asset = address(protocolMint(input.mint));
  const amount = BigInt(input.amountRaw);
  const selection = selectNotes({
    wallet: deps.wallet,
    asset,
    amount,
    ...(input.pinnedInputs ? { pinned: input.pinnedInputs } : {}),
  });

  return {
    asset,
    amount,
    selection,
    transfer: new ConfidentialTransfer(
      deps.keys.address(),
      proofInputs(deps, selection),
      deps.owner
    ),
  };
}

/**
 * `ProofInputUtxo` takes the nullifier as a value rather than deriving it from
 * a key, so it never holds a secret. The value comes from the note the sync
 * stored: sync derives it to decide whether the note is spent, so taking it
 * from there rather than re-deriving keeps one source for it and leaves nothing
 * for a wrong hash-and-blinding pairing to disagree about.
 */
function proofInputs(deps: SpendDeps, selection: NoteSelection): ProofInputUtxo[] {
  const nullifierPublicKey = deps.keys.address().nullifierPublicKey;

  return selection.notes.map(
    (note) =>
      new ProofInputUtxo({
        utxo: note.utxo,
        nullifierPublicKey,
        nullifier: note.nullifier,
        ...(note.dataHash ? { dataHash: note.dataHash } : {}),
        ...(note.ringDataHash ? { ringDataHash: note.ringDataHash } : {}),
      })
  );
}

async function prove(
  deps: SpendDeps,
  transfer: ConfidentialTransfer,
  expectedIntent: PreparedSpendIntent
) {
  const prepared = transfer.prepare();
  validatePreparedTransferIntent(prepared, expectedIntent);

  // One key per transaction, keyed to its first nullifier, and ours to destroy.
  const [transactionViewingKey] = await deps.keys.transactionKeys([
    {
      viewingPublicKey: deps.keys.viewingPublicKeys()[0],
      firstNullifier: prepared.firstNullifier,
    },
  ]);

  let encrypted: EncryptedTransfer;
  try {
    encrypted = encryptConfidentialTransfer(transactionViewingKey, {
      outputs: prepared.outputs,
      assets: deps.wallet.registry,
    });
  } finally {
    transactionViewingKey.destroy();
  }

  // The nullifier secret is consumed here: the inputs arrive with its slots
  // absent and `keys` fills them on the way to the prover.
  return deps.client.proveTransact(prepared.finalize(encrypted), deps.keys);
}
