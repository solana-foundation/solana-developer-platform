import { buildDepositTransaction } from "@heliuslabs/zolana/wallet";
import { address, type Transaction } from "@solana/kit";
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
}

export async function buildShieldTransaction(
  client: Parameters<typeof buildDepositTransaction>[0]["client"],
  input: ShieldFlowInput
): Promise<Transaction> {
  const owner = address(input.owner);
  const asset = protocolMint(input.mint);

  return buildDepositTransaction({
    client,
    // The owner pays and provides the tokens. Fee sponsorship would separate
    // these two, and is deliberately not part of this devnet implementation.
    feePayer: owner,
    depositor: owner,
    // Shielding to one's own identity. A deposit can credit any shielded
    // address, but crediting someone else's is a payment, and SDP models
    // payments as transfers so they go through policy as one.
    recipient: input.material.shieldedAddress,
    amount: BigInt(input.amountRaw),
    ...(asset ? { asset } : {}),
    ...(input.tree ? { tree: address(input.tree) } : {}),
  });
}
