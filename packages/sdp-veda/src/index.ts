/**
 * `@sdp/veda` — kit-native deposit instruction building and position reads for
 * Veda's SVM vaults, over the private `@vedatech/svm-sdk`.
 *
 * Scope: this package BUILDS unsigned instruction plans and READS positions. It
 * never signs, never submits, never touches a database, and holds no runtime
 * credential — Veda's vaults are reached entirely on chain, and the npm token
 * that fetches its SDK is a BUILD credential that no deployment ever sees.
 * Signing and submission belong to the API, which owns custody.
 *
 * Three invariants make it safe to use:
 *
 * - **A closed dependency boundary.** `@vedatech/svm-sdk` (built against
 *   `@solana/kit` 7, while this repo pins 6.8) is confined to `./sdk.ts`.
 *   Everything crossing this module's surface is `@solana/kit` 6.8,
 *   `@sdp/types`, or a decimal string.
 * - **Cluster binding, checked on the OUTPUT.** Every emitted plan is re-checked
 *   against a per-cluster program allowlist. Veda's integration material implies
 *   its devnet and mainnet deployments may share addresses, so nothing about an
 *   instruction distinguishes them — the genesis proof upstream and this
 *   allowlist are the whole defence.
 * - **Money in requires a way out.** A deposit build refuses a deployment whose
 *   withdrawal queue is not configured and wired to the vault (ADR 0002).
 *
 * See `packages/sdp-veda/CLAUDE.md` for the traps and the open questions.
 */

export { acceptAtMintScale, acceptPositiveAtMintScale, mintDecimals } from "./amounts";
export {
  assertNotPortfolioProvider,
  toEarnVaultTransactionPlan,
  VEDA_POSITION_READ_CONCURRENCY,
  VedaVaultDirectClient,
  type VedaVaultOperationRunner,
} from "./client";
export { SdpVedaError, type SdpVedaErrorCode } from "./errors";
export {
  assertPlanTargetsCluster,
  planInstructionCount,
  planProgramAddresses,
  VedaProgramMismatchError,
} from "./guards";
export {
  toClusterConfig,
  type VedaClusterConfig,
  vedaClusterConfig,
  vedaProgramAllowlist,
} from "./programs";
export { createVedaRpc, VEDA_RPC_REQUEST_TIMEOUT_MS, withVedaRpcTimeout } from "./rpc";
export {
  assertVedaVaultUsable,
  buildVedaDepositPlan,
  buildVedaWithdrawPlan,
  mapVedaSdkError,
  previewVedaDeposit,
  previewVedaWithdraw,
  readVedaPosition,
  resetVedaCompatibilityCache,
  VEDA_COMPATIBILITY_TTL_MS,
} from "./sdk";
export type {
  VedaAcceptedAmounts,
  VedaDepositInput,
  VedaDepositQuote,
  VedaDepositQuoteInput,
  VedaDepositQuoteIssue,
  VedaInstructionPlan,
  VedaPosition,
  VedaPositionInput,
  VedaRuntime,
  VedaVaultAssetIdentity,
  VedaWithdrawInput,
  VedaWithdrawQuote,
  VedaWithdrawQuoteInput,
} from "./types";
