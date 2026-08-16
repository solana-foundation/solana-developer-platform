/**
 * `@sdp/kamino` — kit-native deposit/withdraw instruction building for Kamino
 * K-Vaults.
 *
 * Scope: this package BUILDS unsigned instruction plans and READS positions. It
 * never signs, never submits, never touches a database, and holds no credential
 * (Kamino's data surface is public). Signing and submission belong to the API,
 * which owns custody and the Kora fee-payment path.
 *
 * Two invariants make it safe to use:
 *
 * - **Cluster binding.** Kamino deploys a DIFFERENT kvault program per cluster,
 *   and the SDK's ordinary constructor binds only reads to it. Everything here
 *   goes through one bind helper, and every plan is re-checked against a
 *   per-cluster program allowlist before it is returned.
 * - **A closed dependency boundary.** `@kamino-finance/klend-sdk` (built against
 *   `@solana/kit` 2.x, while this repo pins 6.8) and `decimal.js` are confined
 *   to `./sdk.ts`. Everything crossing this module's surface is `@solana/kit`
 *   6.8, `@sdp/types`, or a decimal string.
 *
 * See `packages/sdp-kamino/CLAUDE.md` for the traps and the measurements behind
 * the constants.
 */

export { assertNotPortfolioProvider, KaminoVaultDirectClient } from "./client";
export { SdpKaminoError, type SdpKaminoErrorCode } from "./errors";
export {
  assertPlanTargetsCluster,
  KaminoProgramMismatchError,
  planInstructionCount,
  planProgramAddresses,
} from "./guards";
export {
  foreignKvaultProgramId,
  type KaminoClusterConfig,
  kaminoClusterConfig,
  kaminoProgramAllowlist,
} from "./programs";
// `buildKaminoWithdrawPlan` is deliberately NOT re-exported. It builds a single
// unsized batch with no lookup table, which does not honour
// `KaminoInstructionPlan`'s transaction-sized-batch contract for a multi-reserve
// exit — so it stays package-private (smoke tests only) until that lands, and
// `KaminoVaultDirectClient` withholds the withdraw capability to match.
export { buildKaminoDepositPlan, readKaminoPosition } from "./sdk";
export type {
  KaminoAcceptedAmounts,
  KaminoDepositInput,
  KaminoInstructionPlan,
  KaminoPosition,
  KaminoRuntime,
  KaminoVaultAssetIdentity,
  KaminoWithdrawInput,
} from "./types";
