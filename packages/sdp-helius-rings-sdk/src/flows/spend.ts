import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { MERGE_INPUT_COUNT, transactInstruction } from "@heliuslabs/zolana/interface";
import {
  ConfidentialTransfer,
  ProofInputUtxo,
  type Wallet,
  type WalletAuthority,
  WithdrawalTarget,
} from "@heliuslabs/zolana/transaction";
import {
  buildMergeTransaction,
  resolveRegisteredAddress,
  WalletError,
} from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { type Address, address, type Instruction, type Transaction } from "@solana/kit";
import { type PreparedSpendIntent, validatePreparedTransferIntent } from "../intent-validation.js";
import type { ShieldedMaterial } from "../material.js";
import { protocolMint } from "./mint.js";
import { type NoteSelection, noteId, selectNotes } from "./notes.js";

/**
 * The three flows that consume notes.
 *
 * All of them take the SDK's authority rail rather than its high-level
 * builders: `buildTransferTransaction` and friends select their own inputs and
 * expose no way to say which, and this integration has to record what it spent
 * so a rebuild spends the same notes. The rail is also the only one that works
 * with keys split between custody and a material source, since every
 * `ShieldedKeypair` constructor expands both role keys from one signing secret
 * we do not hold.
 *
 * Each builder here is handed the blockhash rather than fetching its own, so the
 * caller knows the exact height past which the bytes it is about to persist can
 * no longer land.
 */

export interface SpendDeps {
  readonly client: ZolanaClient;
  /** Already synced by the caller; note selection reads it, never fills it. */
  readonly wallet: Wallet;
  readonly authority: WalletAuthority;
  readonly material: ShieldedMaterial;
  readonly owner: Address;
}

/**
 * What a flow produces.
 *
 * Transfer and withdrawal return instructions, because the caller assembles
 * them against a blockhash it chose and can therefore record the exact height
 * past which the bytes it persists can no longer land. Merge returns a finished
 * transaction: `buildMergeTransaction` is the only builder that accepts an
 * input set, and taking it means accepting the blockhash it picked.
 */
export interface SpendResult {
  readonly instructions?: readonly Instruction[];
  readonly transaction?: Transaction;
  /** Commitments spent, to be persisted and pinned on any rebuild. */
  readonly inputNotes: readonly string[];
}

export interface TransferInput {
  readonly recipient: string;
  readonly mint: string;
  readonly amountRaw: string;
  readonly pinnedInputs?: readonly string[];
}

/**
 * Pays a recipient who has registered a shielded identity.
 *
 * The recipient is resolved from their on-chain record rather than supplied as
 * a shielded address: that record is what makes the transfer *registered*, and
 * resolving it is also the only check that they can decrypt what they are about
 * to be sent. Paying an unregistered address would place notes nobody holds the
 * keys for, unrecoverably.
 */
export async function buildTransfer(deps: SpendDeps, input: TransferInput): Promise<SpendResult> {
  const recipient = await resolveRegisteredAddress({
    rpc: deps.client,
    owner: address(input.recipient),
  });
  if (!recipient) {
    throw new HeliusRingsError(
      "invalid_input",
      `${input.recipient} has no registered shielded identity to receive a private transfer`
    );
  }

  const asset = assetAddress(input.mint);
  const amount = BigInt(input.amountRaw);
  const selection = select(deps, asset, amount, input.pinnedInputs);

  const transfer = confidentialTransfer(deps, selection);
  transfer.send(recipient.address, asset, amount);

  return {
    instructions: [
      transactInstruction({
        // The owner's address, not a signer: custody holds the key and signs
        // the assembled transaction afterwards.
        payer: deps.owner,
        inputTree: deps.client.tree,
        outputTree: deps.client.tree,
        data: await prove(deps, transfer, {
          kind: "transfer_registered",
          owner: deps.owner,
          recipient: recipient.address,
          asset,
          amount,
        }),
      }),
    ],
    inputNotes: selection.ids,
  };
}

export interface WithdrawInput {
  readonly recipient: string;
  readonly mint: string;
  readonly amountRaw: string;
  readonly pinnedInputs?: readonly string[];
}

/**
 * Moves shielded value back out to a public address.
 *
 * SOL only. An SPL withdrawal needs the pool's token-interface address and its
 * bump, which the SDK derives internally for `buildWithdrawalTransaction` but
 * does not export. Routing SPL through that builder instead would silently give
 * one asset a weaker recovery guarantee than the others — no pinned inputs —
 * which a caller could not tell from the response, so it is refused here and at
 * validation instead.
 */
export async function buildWithdrawal(deps: SpendDeps, input: WithdrawInput): Promise<SpendResult> {
  if (protocolMint(input.mint) !== undefined) {
    throw new HeliusRingsError(
      "invalid_input",
      "only SOL withdrawals are supported; the SPL token interface address is not derivable through the SDK's public surface"
    );
  }

  const asset = assetAddress(input.mint);
  const amount = BigInt(input.amountRaw);
  const selection = select(deps, asset, amount, input.pinnedInputs);
  const target = WithdrawalTarget.sol({ recipient: address(input.recipient) });

  const withdrawal = confidentialTransfer(deps, selection);
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
          recipient: address(input.recipient),
          amount,
        }),
      }),
    ],
    inputNotes: selection.ids,
  };
}

export interface MergeInput {
  readonly mint: string;
  readonly pinnedInputs?: readonly string[];
}

/**
 * Consolidates fragmented notes into one.
 *
 * A wallet that cannot merge eventually cannot spend: every input enlarges the
 * proof and the circuit caps how many a transaction carries, so enough small
 * notes make a payment unbuildable even when the balance covers it.
 */
export async function buildMerge(deps: SpendDeps, input: MergeInput): Promise<SpendResult> {
  const asset = assetAddress(input.mint);
  const selection = input.pinnedInputs
    ? select(deps, asset, 0n, input.pinnedInputs)
    : mergeable(deps, asset);
  const protocolAsset = protocolMint(input.mint);

  // The only high-level builder used on a spend path, because it is the only
  // one that accepts an input set. Assembling a merge by hand would need the
  // user-record PDA, which the SDK derives internally and does not export.
  const transaction = await buildMergeTransaction({
    client: deps.client,
    wallet: deps.wallet,
    authority: deps.authority,
    feePayer: deps.owner,
    ...(protocolAsset ? { asset: protocolAsset } : {}),
    inputs: selection.notes.map((note) => note.outputContext.hash),
  });

  return { transaction, inputNotes: selection.ids };
}

// --- shared ------------------------------------------------------------------

/**
 * The protocol's address for an SDP mint.
 *
 * Unlike `protocolMint`, never undefined: notes record their asset as an
 * address, and the low-level rail takes it positionally, so native SOL has to
 * be spelled as the system program rather than left out.
 */
function assetAddress(mint: string): Address {
  return protocolMint(mint) ?? address("11111111111111111111111111111111");
}

function select(
  deps: SpendDeps,
  asset: Address,
  amount: bigint,
  pinned: readonly string[] | undefined
): NoteSelection {
  return selectNotes({
    wallet: deps.wallet,
    asset,
    amount,
    ...(pinned ? { pinned } : {}),
  });
}

/**
 * Plain unspent notes of the asset, which is what Zolana's merge rail accepts.
 *
 * Capped at the circuit's input count. Merging the maximum each time is what
 * lets a badly fragmented wallet converge in a few operations rather than one
 * note at a time.
 */
function mergeable(deps: SpendDeps, asset: Address): NoteSelection {
  const notes = [
    ...deps.wallet
      .utxos()
      .filter(
        (note) =>
          !note.spent &&
          note.utxo.asset === asset &&
          note.utxo.zoneProgramId === undefined &&
          note.dataHash === undefined &&
          note.zoneDataHash === undefined &&
          note.utxo.data.isEmpty()
      ),
  ];
  const trees = new Set(notes.map((note) => note.outputContext.tree));
  if (trees.size > 1) {
    throw new WalletError("WALLET_MULTIPLE_INPUT_TREES");
  }

  notes.sort((left, right) =>
    left.utxo.amount < right.utxo.amount ? -1 : left.utxo.amount > right.utxo.amount ? 1 : 0
  );

  if (notes.length < 2) {
    throw new HeliusRingsError(
      "invalid_input",
      "a merge needs at least two unspent notes of the asset"
    );
  }

  const chosen = notes.slice(0, MERGE_INPUT_COUNT);
  return {
    notes: chosen,
    ids: chosen.map(noteId),
    total: chosen.reduce((sum, note) => sum + note.utxo.amount, 0n),
  };
}

function proofInputs(deps: SpendDeps, selection: NoteSelection): ProofInputUtxo[] {
  return selection.notes.map(
    (note) =>
      new ProofInputUtxo({
        utxo: note.utxo,
        nullifierKey: deps.material.nullifierKey,
        ...(note.dataHash ? { dataHash: note.dataHash } : {}),
        ...(note.zoneDataHash ? { zoneDataHash: note.zoneDataHash } : {}),
      })
  );
}

function confidentialTransfer(deps: SpendDeps, selection: NoteSelection): ConfidentialTransfer {
  return new ConfidentialTransfer(
    deps.material.shieldedAddress,
    proofInputs(deps, selection),
    deps.owner
  );
}

/**
 * Encrypts the outputs, then proves.
 *
 * This is where the custody split shows: `prepare` hands back the outputs, the
 * authority encrypts them under a transaction viewing key derived from material
 * it holds, and `finalize` takes the ciphertext back. The SDK's keypair rail
 * does all three in one call, which it can only do because it has the whole
 * keypair in process.
 */
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
