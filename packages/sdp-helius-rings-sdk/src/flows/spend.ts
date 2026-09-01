import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { transactInstruction } from "@heliuslabs/zolana/interface";
import {
  ConfidentialTransfer,
  ProofInputUtxo,
  type Wallet,
  type WalletAuthority,
  WithdrawalTarget,
} from "@heliuslabs/zolana/transaction";
import { type Address, address, type Instruction } from "@solana/kit";
import { type PreparedSpendIntent, validatePreparedTransferIntent } from "../intent-validation.js";
import type { ShieldedMaterial } from "../material.js";
import { protocolMint, requireProtocolSol } from "./mint.js";
import { type NoteSelection, selectNotes } from "./notes.js";

export interface SpendDeps {
  readonly client: ZolanaClient;
  readonly wallet: Wallet;
  readonly authority: WalletAuthority;
  readonly material: ShieldedMaterial;
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

  const asset = address(protocolMint(input.mint));
  const amount = BigInt(input.amountRaw);
  const recipient = address(input.recipient);
  const selection = selectNotes({
    wallet: deps.wallet,
    asset,
    amount,
    ...(input.pinnedInputs ? { pinned: input.pinnedInputs } : {}),
  });

  const target = WithdrawalTarget.sol({ recipient });
  const withdrawal = new ConfidentialTransfer(
    deps.material.shieldedAddress,
    proofInputs(deps, selection),
    deps.owner
  );
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

  const asset = address(protocolMint(input.mint));
  const amount = BigInt(input.amountRaw);
  const selection = selectNotes({
    wallet: deps.wallet,
    asset,
    amount,
    ...(input.pinnedInputs ? { pinned: input.pinnedInputs } : {}),
  });

  const transfer = new ConfidentialTransfer(
    deps.material.shieldedAddress,
    proofInputs(deps, selection),
    deps.owner
  );
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

function proofInputs(deps: SpendDeps, selection: NoteSelection): ProofInputUtxo[] {
  return selection.notes.map(
    (note) =>
      new ProofInputUtxo({
        utxo: note.utxo,
        nullifierKey: deps.material.nullifierKey,
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
  const encrypted = await deps.authority.encryptConfidentialTransfer({
    firstNullifier: prepared.firstNullifier,
    outputs: prepared.outputs,
    assets: deps.wallet.registry,
  });

  return deps.client.proveTransact(prepared.finalize(encrypted));
}
