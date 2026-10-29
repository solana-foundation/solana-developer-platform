import type { RpcUnavailableReason } from "@sdp/types/rpc";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";

export type SdpRpcErrorCode =
  | "BAD_REQUEST"
  | "SOLANA_RPC_ERROR"
  | "RPC_UNAVAILABLE"
  | "CLUSTER_SCOPE_MISSING"
  | "CLUSTER_SCOPE_CONFLICT";

const ERROR_STATUS_CODES: Record<SdpRpcErrorCode, number> = {
  BAD_REQUEST: 400,
  SOLANA_RPC_ERROR: 502,
  RPC_UNAVAILABLE: 503,
  CLUSTER_SCOPE_MISSING: 500,
  CLUSTER_SCOPE_CONFLICT: 500,
};

export class SdpRpcError extends Error {
  public readonly statusCode: number;

  constructor(
    public readonly code: SdpRpcErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SdpRpcError";
    this.statusCode = ERROR_STATUS_CODES[code];
  }
}

/**
 * Solana RPC can't serve the request, with `details: { reason, cluster }` saying why (see
 * `RPC_UNAVAILABLE_REASONS`). Callers branch on `reason`, never on the message.
 */
export class RpcUnavailableError extends SdpRpcError {
  /** The cluster RPC was unavailable for. */
  public readonly cluster: SolanaCluster;

  /**
   * @param reason - Why RPC is unavailable.
   * @param message - What failed, never quoting an endpoint URL.
   * @param details - The cluster, plus any reason-specific facts.
   */
  constructor(
    public readonly reason: RpcUnavailableReason,
    message: string,
    details: { cluster: SolanaCluster } & Record<string, unknown>
  ) {
    super("RPC_UNAVAILABLE", message, { reason, ...details });
    this.name = "RpcUnavailableError";
    this.cluster = details.cluster;
  }
}

export class RpcHttpStatusError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * An RPC attempt cut off by SDP's own deadline. Callers classify it by type, never by message.
 * `details.timedOut` stays for readers that walk error records.
 */
export class RpcTimeoutError extends SdpRpcError {
  /**
   * @param timeoutMs - The deadline that elapsed.
   * @param options - `label` names the client in the message (default `RPC`); `cause` is kept.
   */
  constructor(timeoutMs: number, options: { label?: string; cause?: unknown } = {}) {
    super("SOLANA_RPC_ERROR", `${options.label ?? "RPC"} request timed out after ${timeoutMs}ms`, {
      timedOut: true,
    });
    this.name = "RpcTimeoutError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * A read answered from a bank below the slot the caller demanded (`minContextSlot`), found by
 * SDP's own `context.slot` check because an upstream may ignore the option. The node was behind,
 * so its answer is withheld rather than trusted. Callers classify it by type, never by message.
 */
export class MinContextSlotNotReachedError extends SdpRpcError {
  /**
   * @param contextSlot - The slot of the bank that answered.
   * @param minContextSlot - The slot the caller demanded.
   */
  constructor(
    public readonly contextSlot: bigint,
    public readonly minContextSlot: bigint
  ) {
    super("SOLANA_RPC_ERROR", "Solana RPC answered from a slot below minContextSlot", {
      contextSlot: contextSlot.toString(),
      minContextSlot: minContextSlot.toString(),
    });
  }
}

export function solanaRpcError(message: string, details?: Record<string, unknown>): SdpRpcError {
  return new SdpRpcError("SOLANA_RPC_ERROR", message, details);
}
