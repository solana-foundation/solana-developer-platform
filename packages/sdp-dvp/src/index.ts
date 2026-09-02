/**
 * `@sdp/dvp` — a `@solana/kit` client for the Solana DvP swap program
 * (`solana-foundation/dvp`), generated from the vendored Codama IDL (see
 * `scripts/generate.ts`).
 *
 * The client targets `dvp34bdb…`, the `origin/dev` build live on devnet. The
 * IDL vendored here declares that same id; `scripts/generate.ts` asserts the
 * two agree so a re-vendor from the wrong branch fails codegen instead of
 * silently pointing every PDA deriver at an undeployed program.
 *
 * ## Reading a trade
 *
 * This module deliberately does NOT re-export the generated `fetchSwapDvp`,
 * `fetchMaybeSwapDvp`, `decodeSwapDvp` or their batch variants. Those decode
 * whatever bytes sit at an address with no owner or size check, and
 * `CreateDvp` is permissionless — so an attacker-authored account that decodes
 * as a `SwapDvp` would be handed back as a real trade. Escrow addresses derive
 * from the PDA and mint rather than from the terms, so a raw funding transfer
 * lands against terms nobody agreed to and the attacker drains it.
 *
 * Read a trade with `verifySwapDvp` (owner + size + canonical PDA), then check
 * it against the deal with `assertSwapDvpTerms` (amounts, time bounds, and
 * both settlement destinations — none of which the PDA binds). Both steps are
 * needed; neither is sufficient alone.
 *
 * Do not hand-edit `src/generated` — re-run `pnpm --filter @sdp/dvp generate`.
 */

// The `SwapDvp` shape and its codecs are safe to expose; the unchecked
// fetch/decode readers in the same generated module are not.
export {
  getSwapDvpCodec,
  getSwapDvpDecoder,
  getSwapDvpEncoder,
  type SwapDvp,
  type SwapDvpArgs,
} from "./generated/accounts/swapDvp";
// Instruction builders, program errors, and the program address. The accounts
// barrel is deliberately absent — see the selective re-export above.
export * from "./generated/errors";
export * from "./generated/instructions";
export * from "./generated/programs";
// Friendlier alias for the (verbose, codama-suffixed) program address constant.
export { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS as DVP_SWAP_PROGRAM_ADDRESS } from "./generated/programs";

export { getSafeI64Encoder, getSafeU64Encoder } from "./safeNumberCodecs";
export {
  assertSwapDvpTerms,
  type ExpectedSwapDvpTerms,
  SwapDvpTermsMismatchError,
} from "./terms";
export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  decodeSwapDvpChecked,
  fetchSwapDvpChecked,
  findSwapDvpEscrowAta,
  findSwapDvpPda,
  SWAP_DVP_ACCOUNT_SIZE,
  SWAP_DVP_SEED,
  SwapDvpVerificationError,
  verifySwapDvp,
} from "./verify";
