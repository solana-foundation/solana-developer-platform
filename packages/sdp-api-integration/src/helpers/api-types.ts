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
    listAddress?: string;
    simulation?: { success: boolean; logs: string[]; unitsConsumed?: number };
    /**
     * Present when the create tx had to be prepared with an empty metadata uri
     * to stay under the packet limit. The client must set the real uri in a
     * follow-up tx (POST .../deploy/prepare-metadata) after the create tx
     * confirms. Absent on the single-tx fast path.
     */
    metadataUriFollowUp?: { required: true; uri: string };
  }> {}

export interface DeployPrepareMetadataApiResponse
  extends ApiResponse<{
    transaction: { serialized: string; blockhash: string; lastValidBlockHeight?: string } | null;
    uri: string;
    simulation?: { success: boolean; logs: string[]; unitsConsumed?: number };
  }> {}

/**
 * Response of POST .../deploy/confirm — the step that records the mint after a
 * client signs and submits a prepared (non-custodial) deploy tx. Returns the
 * now-deployed token.
 */
export interface DeployConfirmApiResponse extends ApiResponse<{ token: Token }> {}

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
