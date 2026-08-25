import type { ShieldedAddress } from "@heliuslabs/zolana";
import {
  type PreparedTransfer,
  type ProofOutputUtxo,
  SENDER_SLOT_COUNT,
} from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import type { Address } from "@solana/kit";
import { canonicalShieldedIdentity } from "./material.js";

const SOL: Address = "11111111111111111111111111111111" as Address;
const SAFE_MESSAGE = "the prepared Rings transfer does not match the requested intent";

export type PreparedSpendIntent =
  | Readonly<{
      kind: "transfer_registered";
      owner: Address;
      recipient: ShieldedAddress;
      asset: Address;
      amount: bigint;
    }>
  | Readonly<{
      kind: "withdraw";
      owner: Address;
      recipient: Address;
      amount: bigint;
    }>;

function matchesIdentity(output: ProofOutputUtxo, expected: ShieldedAddress): boolean {
  return (
    output.ownerAddress !== undefined &&
    canonicalShieldedIdentity(output.ownerAddress) === canonicalShieldedIdentity(expected)
  );
}

function isPlainOutput(output: ProofOutputUtxo): boolean {
  return (
    output.zoneProgramId === undefined &&
    output.zoneDataHash === undefined &&
    output.dataHash === undefined &&
    output.data.isEmpty()
  );
}

function isNormalSenderSlot(
  output: ProofOutputUtxo,
  owner: ShieldedAddress,
  expectedAsset: Address
): boolean {
  if (!isPlainOutput(output)) return false;
  if (output.isDummy()) {
    return output.amount === 0n && output.asset === SOL && output.ownerAddress === undefined;
  }
  return output.asset === expectedAsset && matchesIdentity(output, owner);
}

function hasExpectedSenderSlots(prepared: PreparedTransfer, requestedAsset: Address): boolean {
  const splSlot = prepared.outputs[0];
  const solSlot = prepared.outputs[1];
  if (!(splSlot && solSlot)) return false;

  const expectedSplAsset = requestedAsset === SOL ? SOL : requestedAsset;
  return (
    isNormalSenderSlot(splSlot, prepared.owner, expectedSplAsset) &&
    (requestedAsset !== SOL || splSlot.isDummy()) &&
    isNormalSenderSlot(solSlot, prepared.owner, SOL)
  );
}

function matchesBase(prepared: PreparedTransfer, intent: PreparedSpendIntent): boolean {
  return (
    prepared.payer === intent.owner &&
    prepared.owner.solanaAddress() === intent.owner &&
    prepared.outputs.length >= SENDER_SLOT_COUNT
  );
}

function matchesRegisteredTransfer(
  prepared: PreparedTransfer,
  intent: Extract<PreparedSpendIntent, { kind: "transfer_registered" }>
): boolean {
  const recipient = prepared.outputs[SENDER_SLOT_COUNT];
  return (
    prepared.interfaceTransfers.length === 0 &&
    prepared.outputs.length === SENDER_SLOT_COUNT + 1 &&
    hasExpectedSenderSlots(prepared, intent.asset) &&
    recipient !== undefined &&
    isPlainOutput(recipient) &&
    !recipient.isDummy() &&
    matchesIdentity(recipient, intent.recipient) &&
    recipient.asset === intent.asset &&
    recipient.amount === intent.amount
  );
}

function matchesWithdrawal(
  prepared: PreparedTransfer,
  intent: Extract<PreparedSpendIntent, { kind: "withdraw" }>
): boolean {
  const settlement = prepared.interfaceTransfers[0];
  return (
    prepared.outputs.length === SENDER_SLOT_COUNT &&
    hasExpectedSenderSlots(prepared, SOL) &&
    prepared.interfaceTransfers.length === 1 &&
    settlement?.kind === "sol" &&
    settlement.isDeposit === false &&
    settlement.userSolAccount === intent.recipient &&
    settlement.amount === intent.amount
  );
}

/**
 * Binds Zolana's typed, still-readable transfer to the approved request before
 * any output is encrypted or sent to the prover.
 */
export function validatePreparedTransferIntent(
  prepared: PreparedTransfer,
  intent: PreparedSpendIntent
): void {
  try {
    const matches =
      matchesBase(prepared, intent) &&
      (intent.kind === "transfer_registered"
        ? matchesRegisteredTransfer(prepared, intent)
        : matchesWithdrawal(prepared, intent));

    if (!matches) throw new Error("intent mismatch");
  } catch {
    // Do not retain the malformed object or expected intent as a cause: both
    // can carry private note material that must never reach an adapter log.
    throw new HeliusRingsError("invalid_input", SAFE_MESSAGE);
  }
}
