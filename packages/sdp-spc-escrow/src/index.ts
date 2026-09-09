/**
 * `@sdp/spc-escrow` — a `@solana/kit` client for the Solana Private Channels
 * escrow program, generated from the vendored Codama IDL (see `scripts/generate.ts`).
 *
 * The client targets the REAL deployed program `9tgHa1…` (the IDL's declared id is
 * a placeholder), and its `deposit` builder auto-derives the allowedMint / ATA /
 * eventAuthority PDAs under that program. Callers pass only domain inputs:
 * `getDepositInstructionAsync({ payer, user, instance, mint, amount, recipient })`.
 *
 * Do not hand-edit `src/generated` — re-run `pnpm --filter @sdp/spc-escrow generate`.
 */

export * from "./generated";
// Friendlier alias for the (verbose, codama-suffixed) program address constant.
export { PRIVATE_CHANNEL_ESCROW_PROGRAM_PROGRAM_ADDRESS as PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } from "./generated";
