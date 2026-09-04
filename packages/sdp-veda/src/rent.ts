import type { Address, Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "./programs";

/**
 * Rent attribution for the associated token accounts a Veda plan creates.
 *
 * `@vedatech/svm-sdk` (0.1.0-alpha.1) hardcodes the OWNER as the funding payer
 * of every ATA it creates idempotently — its `DepositInput` carries no payer
 * knob at all. The Earn contract says otherwise: when the API resolves
 * sponsorship, `rentPayer` names the sponsor and the provider must charge
 * account creation to it, or a custody wallet holding zero SOL fails its first
 * deposit with the fee sponsored and the rent not
 * (`vault-sponsorship.ts` calls that split unrepresentable; this module is what
 * keeps it unrepresentable for Veda).
 *
 * The mechanism is a payer SWAP, not extra instructions: the ATA program's
 * `Create`/`CreateIdempotent` ABI fixes the funding account at index 0, so
 * replacing that one address re-funds the create without touching order,
 * count, or the adjacency of any protected instruction group. The swapped-in
 * payer keeps the original writable+signer role; its signature is the same
 * sponsor signature that already covers the transaction fee (Solana
 * deduplicates account keys, so one `signAsFeePayer` satisfies both roles).
 *
 * These helpers are deliberately outside `./sdk.ts` — they need only this
 * repo's kit, so the firewall stays intact and they stay unit-testable without
 * loading the SDK.
 */

/** `Create` (data absent, empty, or `[0]`) and `CreateIdempotent` (`[1]`). */
const ATA_CREATE_ACCOUNTS = 6;
const ATA_FUNDING_PAYER_INDEX = 0;
const ATA_ACCOUNT_INDEX = 1;
const ATA_MINT_INDEX = 3;

/**
 * True for the ATA program's two account-creating instructions, whose funding
 * payer sits at account index 0. `RecoverNested` (discriminator 2) carries no
 * payer there and must never be rewritten.
 */
export function isAtaCreateInstruction(instruction: Instruction): boolean {
  if (String(instruction.programAddress) !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS) return false;
  if ((instruction.accounts?.length ?? 0) < ATA_CREATE_ACCOUNTS) return false;
  const discriminator = instruction.data?.[0];
  return discriminator === undefined || discriminator === 0 || discriminator === 1;
}

/**
 * Charge every ATA create in `instructions` to `rentPayer` instead of whoever
 * the builder named (the owner, for Veda's SDK).
 *
 * Only the funding account's ADDRESS changes; its role stays exactly as
 * emitted, and every other account and instruction is returned untouched. The
 * result is plain instruction data — any embedded signer object on the swapped
 * account is dropped on purpose, because no one holds the sponsor's key here:
 * the paymaster supplies that signature after compilation.
 */
export function chargeAtaCreationRentTo(
  instructions: readonly Instruction[],
  rentPayer: Address
): readonly Instruction[] {
  return instructions.map((instruction) => {
    if (!isAtaCreateInstruction(instruction)) return instruction;
    const accounts = instruction.accounts ?? [];
    const payer = accounts[ATA_FUNDING_PAYER_INDEX];
    if (payer === undefined || payer.address === rentPayer) return instruction;
    return {
      ...instruction,
      accounts: [
        { address: rentPayer, role: payer.role },
        ...accounts.slice(ATA_FUNDING_PAYER_INDEX + 1),
      ],
    };
  });
}

/**
 * The associated token account a plan creates for `mint`, or undefined when
 * the plan creates none. Read from the instruction's own accounts (ata at
 * index 1, mint at index 3) rather than re-derived, so the answer is about the
 * plan that will execute, not about arithmetic this package repeats.
 */
export function createdAtaAddressForMint(
  instructions: readonly Instruction[],
  mint: Address
): Address | undefined {
  for (const instruction of instructions) {
    if (!isAtaCreateInstruction(instruction)) continue;
    const accounts = instruction.accounts ?? [];
    if (accounts[ATA_MINT_INDEX]?.address !== mint) continue;
    return accounts[ATA_ACCOUNT_INDEX]?.address;
  }
  return undefined;
}
