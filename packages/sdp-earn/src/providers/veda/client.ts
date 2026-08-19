import { VEDA_DEPOSIT_TOKEN_SYMBOLS } from "@sdp/types/veda-programs";
import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/**
 * Veda vault-infra client — the catalogue half. `@sdp/veda` extends this class
 * with the vault-direct capability (deposit building and position reads); this
 * package stays SDK-free so the hourly catalogue cron never loads a chain SDK.
 */
export class VedaEarnClient extends StubEarnClient {
  readonly provider = "veda" as const;

  /**
   * What SDP is willing to front, narrowed from the scaffold's guess.
   *
   * - **`defi` only.** A Veda vault is an on-chain program that mints shares
   *   against deposited assets, and that is the whole of what its own state
   *   establishes. It reaches strategies through pre-approved CPI digests, so
   *   the underlying exposure could in principle be real-world backed — but
   *   `rwa` is the one classification an integrator FILTERS on to find
   *   instruments with real-world backing, so asserting it needs something
   *   Veda publishes on-chain, not an inference from what a vault might hold.
   *   Same rule that keeps Kamino's snapshots `defi` (see
   *   `packages/sdp-earn/CLAUDE.md` → the K-vault name trust boundary).
   * - **USDC only.** The scaffold also claimed USDG and USDT, which no Veda
   *   material supports. USDT additionally has no devnet mint, so a devnet
   *   snapshot naming it could never pass `isStrategyWithinDeclaredSupport`
   *   and would warn on every hourly pass forever.
   *
   * Shared with `@sdp/veda` through `@sdp/types` rather than restated, so the
   * asset the catalogue admits and the asset the builder will spend cannot
   * drift apart.
   */
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi"],
    depositTokens: VEDA_DEPOSIT_TOKEN_SYMBOLS,
  };
}
