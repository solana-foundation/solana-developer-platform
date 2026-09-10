export type SdpRpcErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RPC_NOT_CONFIGURED"
  | "INTERNAL_ERROR"
  | "SOLANA_RPC_ERROR";

const ERROR_STATUS_CODES: Record<SdpRpcErrorCode, number> = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RPC_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
  SOLANA_RPC_ERROR: 502,
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

export function solanaRpcError(message: string, details?: Record<string, unknown>): SdpRpcError {
  return new SdpRpcError("SOLANA_RPC_ERROR", message, details);
}

/**
 * Create an unavailable error for a cluster without an RPC endpoint.
 *
 * @param message - Cluster-specific configuration error message.
 * @returns An RPC package error mapped to HTTP 503.
 */
export function rpcNotConfigured(message: string): SdpRpcError {
  return new SdpRpcError("RPC_NOT_CONFIGURED", message);
}
