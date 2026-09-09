import { buildRingDepositTransaction } from "@heliuslabs/zolana/ring";
import { buildDepositTransaction } from "@heliuslabs/zolana/wallet";
import { address, type Transaction } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "../error-bridge.js";
import type { ShieldedMaterial } from "../material.js";
import { protocolMint } from "./mint.js";

/**
 * Moves public tokens into the wallet's own shielded balance.
 *
 * The one flow that needs no `WalletAuthority`: a deposit creates notes rather
 * than consuming them, so there is nothing to prove ownership of and no
 * approval for the SDK to request. It needs the recipient's shielded address
 * and the depositor's signature, both of which we have without a spend path.
 *
 * A deposit is also public. The depositor, recipient, asset and amount are all
 * visible on chain; privacy begins with the notes it creates, not with it.
 */

export interface ShieldFlowInput {
  readonly owner: string;
  readonly material: ShieldedMaterial;
  readonly mint: string;
  readonly amountRaw: string;
  readonly tree?: string;
  /**
   * Ring the operation was pinned to at prepare time. Set, the deposit is
   * ring-bound, so only that ring's transact can ever spend the note; unset,
   * it lands in the default public pool. Persisted state rather than
   * caller-echoable input, so a bad value is a config_error and its text
   * never echoes back.
   */
  readonly ringProgramId?: string;
}

export async function buildShieldTransaction(
  client: Parameters<typeof buildDepositTransaction>[0]["client"],
  input: ShieldFlowInput
): Promise<Transaction> {
  const owner = address(input.owner);
  const asset = protocolMint(input.mint);
  const pinnedRing = input.ringProgramId;
  const ringProgramId =
    pinnedRing === undefined
      ? undefined
      : withConfiguredAddressErrorBridge(() => address(pinnedRing));

  const deposit = {
    client,
    feePayer: owner,
    depositor: owner,
    recipient: input.material.shieldedAddress,
    amount: BigInt(input.amountRaw),
    ...(asset ? { asset: address(asset) } : {}),
    ...(input.tree ? { tree: address(input.tree) } : {}),
  };

  return ringProgramId === undefined
    ? buildDepositTransaction(deposit)
    : buildRingDepositTransaction({ ...deposit, ringProgramId });
}
