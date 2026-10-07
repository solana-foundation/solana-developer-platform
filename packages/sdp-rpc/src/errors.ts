export type SdpRpcErrorCode = "BAD_REQUEST" | "SOLANA_RPC_ERROR";

const ERROR_STATUS_CODES: Record<SdpRpcErrorCode, number> = {
  BAD_REQUEST: 400,
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

export class RpcHttpStatusError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

export function solanaRpcError(message: string, details?: Record<string, unknown>): SdpRpcError {
  return new SdpRpcError("SOLANA_RPC_ERROR", message, details);
}
