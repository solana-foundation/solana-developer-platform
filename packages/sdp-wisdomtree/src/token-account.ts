import type { Address } from "@solana/kit";
import { AccountState, extension, getTokenEncoder } from "@solana-program/token-2022";

/**
 * Encode the initialized Token-2022 account shape inherited from WisdomTree's
 * live fund mints. The ATA program installs ImmutableOwner, while the mint's
 * TransferHook and Pausable extensions require their account-side companions.
 */
export function encodeWisdomTreeFundTokenAccount(
  mint: Address,
  owner: Address,
  amount = 0n
): Uint8Array {
  return Uint8Array.from(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions: [
        extension("ImmutableOwner", {}),
        extension("TransferHookAccount", { transferring: false }),
        extension("PausableAccount", {}),
      ],
    })
  );
}
