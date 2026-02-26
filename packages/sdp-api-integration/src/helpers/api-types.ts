import type { Token } from "@sdp/types";

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface TokenApiResponse extends ApiResponse<{ token: Token }> {}

export interface DeployPrepareApiResponse
  extends ApiResponse<{
    transaction: { serialized: string; blockhash: string; lastValidBlockHeight?: string };
    mint: string;
    simulation?: { success: boolean; logs: string[]; unitsConsumed?: number };
  }> {}

export interface MintPrepareApiResponse
  extends ApiResponse<{
    transaction: TransactionRecord;
    preparedTransaction: { serialized: string; blockhash: string; lastValidBlockHeight?: string };
    tokenAccount: string;
    simulation?: { success: boolean; logs: string[]; unitsConsumed?: number };
  }> {}

export interface TransactionRecord {
  id: string;
  status: string;
  signature?: string;
  type: string;
  [key: string]: unknown;
}

export interface MintApiResponse
  extends ApiResponse<{
    transaction: TransactionRecord;
    tokenAccount: string;
  }> {}

export interface BurnApiResponse
  extends ApiResponse<{
    transaction: TransactionRecord;
  }> {}

export interface FreezeApiResponse
  extends ApiResponse<{
    frozenAccount: {
      id: string;
      accountAddress: string;
      reason?: string;
      signature?: string;
    };
  }> {}

export interface UnfreezeApiResponse
  extends ApiResponse<{
    frozenAccount: {
      id: string;
      accountAddress: string;
      unfrozenAt?: string;
      signature?: string;
    };
  }> {}

export interface SignerCheckApiResponse
  extends ApiResponse<{
    walletId: string;
    walletAddress: string;
    feePayer: string;
    memo: string;
    signature: string;
    slot: number;
    blockTime: string;
  }> {}

export interface TokenAllowlistResponse
  extends ApiResponse<{
    entry: {
      id: string;
      tokenId: string;
      address: string;
      label?: string;
      status: string;
    };
  }> {}

export interface AllowlistListResponse
  extends ApiResponse<{
    data: Array<{
      id: string;
      tokenId: string;
      address: string;
      label?: string;
      status: string;
    }>;
  }> {}
