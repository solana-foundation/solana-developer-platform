import type { SolanaCluster } from "@sdp/types";

/**
 * Errors this package raises, mirroring `@sdp/earn/errors` in shape: a `code`
 * the API can map to a status, and a message that says what was actually wrong.
 *
 * Deliberately NOT re-using `@sdp/earn`'s constructors — the same call the
 * Kamino package makes. `@sdp/earn` owns the CATALOGUE taxonomy (HTTP statuses,
 * provider-configured checks); this package owns a build taxonomy, and sharing
 * constructors would make an instruction-builder failure look like a provider
 * outage to anything matching on `SdpEarnError`.
 */
export type SdpVedaErrorCode =
  /** A caller amount that is malformed, zero, over-precise, or out of range. */
  | "INVALID_AMOUNT"
  /** Vault, asset or position state could not be read on this cluster. */
  | "VAULT_UNREADABLE"
  /** An emitted instruction named a program that is not this cluster's. */
  | "PROGRAM_MISMATCH"
  /** SDP has no confirmed Veda deployment for the cluster in play. */
  | "DEPLOYMENT_NOT_CONFIGURED"
  /** The live deployment does not satisfy what SDP requires of it. */
  | "INCOMPATIBLE_DEPLOYMENT"
  /** The vault refuses this deposit right now (paused, capped, asset off). */
  | "DEPOSIT_REFUSED"
  /** The vault refuses this exit right now (paused, locked, restricted). */
  | "WITHDRAW_REFUSED"
  /** The vault requires an external compliance approval SDP does not implement. */
  | "COMPLIANCE_APPROVAL_REQUIRED"
  /** The vault's configuration cannot be expressed by SDP's deposit contract. */
  | "UNSUPPORTED_VAULT";

export class SdpVedaError extends Error {
  constructor(
    readonly code: SdpVedaErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SdpVedaError";
  }
}

/**
 * A caller-supplied amount that is not a decimal string, is negative, or is
 * zero. Raised BEFORE any RPC call — an unparseable amount is a programming
 * error on the caller's side and must never reach the chain.
 */
export function invalidAmount(field: string, value: string): SdpVedaError {
  return new SdpVedaError(
    "INVALID_AMOUNT",
    `Veda ${field} must be a positive decimal string; received ${JSON.stringify(value)}`
  );
}

/**
 * A caller-supplied amount that is finer than the mint can represent.
 *
 * Distinct from `invalidAmount` because the value IS a well-formed decimal — it
 * simply carries more places than the mint has atoms. Veda's SDK takes atomic
 * `bigint`s, so SDP does the conversion, and the only two options at the
 * boundary are refuse or round. Rounding is the dangerous one: a deposit of
 * `1.0000009` on a six-decimal mint would be RECORDED as 1.0000009 while
 * 1.000000 moved, and a `minSharesOut` rounded below one atom becomes `0` — a
 * slippage floor that reads as protection everywhere and imposes none on chain.
 */
export function amountTooPrecise(field: string, value: string, decimals: number): SdpVedaError {
  return new SdpVedaError(
    "INVALID_AMOUNT",
    `Veda ${field} ${JSON.stringify(value)} has more precision than its mint supports ` +
      `(${decimals} decimals). Encoding it would move a different amount than was requested.`
  );
}

/** A decimal whose mint-scaled integer cannot fit Veda's on-chain u64 field. */
export function amountOutOfRange(field: string, value: string): SdpVedaError {
  return new SdpVedaError(
    "INVALID_AMOUNT",
    `Veda ${field} ${JSON.stringify(value)} exceeds the maximum unsigned 64-bit base-unit amount`
  );
}

/**
 * SDP has no confirmed Veda deployment for this cluster.
 *
 * Not an outage and not a bug: `VEDA_DEPLOYMENTS` in `@sdp/types` is empty
 * until Veda confirms its program and vault-state addresses per cluster, and
 * building against an unverified address is the failure this refuses to risk.
 */
export function deploymentNotConfigured(cluster: SolanaCluster): SdpVedaError {
  return new SdpVedaError(
    "DEPLOYMENT_NOT_CONFIGURED",
    `SDP has no confirmed Veda deployment for ${cluster}. Add its program and vault-state ` +
      "addresses to @sdp/types/veda-programs once Veda confirms them."
  );
}

/**
 * The vault account could not be read on this cluster.
 *
 * The likeliest cause is the RPC pointing at the wrong chain. Veda's
 * integration material implies devnet and mainnet may share program addresses,
 * so a cluster mismatch does not present as a connection error — it presents as
 * "this vault does not exist", or worse, as a different chain's vault at the
 * same address. The message names both so the reader checks the right thing.
 */
export function vaultUnreadable(
  vault: string,
  cluster: SolanaCluster,
  cause: unknown
): SdpVedaError {
  return new SdpVedaError(
    "VAULT_UNREADABLE",
    `Veda vault ${vault} could not be read on ${cluster}. Check that the RPC endpoint serves ` +
      "that cluster — a mismatched RPC reports a missing vault, not a connection error.",
    { cause }
  );
}
