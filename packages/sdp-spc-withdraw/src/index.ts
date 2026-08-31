/**
 * `@sdp/spc-withdraw` — a `@solana/kit` client for the Solana Private Channels
 * withdraw program, generated from the vendored Codama IDL (see `scripts/generate.ts`).
 *
 * The `withdrawFunds` instruction is an SPL `Burn`: the user burns channel-chain
 * tokens, and the operator later releases the matching real USDC on devnet. The
 * IDL already declares the real deployed program id (`J231K9…`) — unlike escrow,
 * there is no program-id override and no PDAs. The builder auto-derives the
 * user's classic-Token ATA (`tokenAccount`); callers pass only domain inputs:
 * `getWithdrawFundsInstructionAsync({ user, mint, amount, destination })`.
 *
 * Do not hand-edit `src/generated` — re-run `pnpm --filter @sdp/spc-withdraw generate`.
 */

export * from "./generated";
// Friendlier alias for the (verbose, codama-suffixed) program address constant.
export { PRIVATE_CHANNEL_WITHDRAW_PROGRAM_PROGRAM_ADDRESS as PRIVATE_CHANNEL_WITHDRAW_PROGRAM_ADDRESS } from "./generated";
