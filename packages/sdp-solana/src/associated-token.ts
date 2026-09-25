/**
 * Associated-token-account derivation shared across the platform.
 *
 * Deliberately the SAME derivation the API's Earn swap service uses to pin a
 * Jupiter route's source and destination accounts (`findAssociatedTokenPda` in
 * `services/earn/jupiter-swap.service.ts`): a position reader that counts only
 * this address therefore agrees with what a built swap can actually spend.
 */

import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

// biome-ignore lint/security/noSecrets: public Associated Token program id, not a secret.
const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * The associated token account of `owner` holding `mint` under `tokenProgram`
 * (the classic SPL Token or Token-2022 program address — the seeds are the
 * same shape for both). The associated-token program derives the account, so
 * this never depends on an RPC read.
 */
export async function associatedTokenAccountAddress(input: {
  owner: string;
  mint: string;
  tokenProgram: string;
}): Promise<string> {
  // Each seed is a 32-byte public key: encode the base58 addresses, same as
  // `findAssociatedTokenPda` does.
  const encode = getAddressEncoder();
  const [accountAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      encode.encode(address(input.owner)),
      encode.encode(address(input.tokenProgram)),
      encode.encode(address(input.mint)),
    ],
  });
  return accountAddress;
}
