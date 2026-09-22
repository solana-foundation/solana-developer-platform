export interface YieldStrategy {
  id: string;
  provider: string;
  providerReference: string;
  name: string;
  sourceKind: "defi" | "rwa";
  depositMints: string[];
  shareMint?: string;
  currentApy?: string;
  liquidityTerm: "instant" | "delayed";
  redemptionDelayDays?: number;
  status: "active" | "paused" | "deprecated";
  hostCluster: "devnet" | "mainnet-beta";
  fundable: boolean;
  depositSlippage: SlippagePolicy | null;
  withdrawalSlippage: SlippagePolicy | null;
}

export interface SlippagePolicy {
  quoteRequired: true;
  defaultToleranceBps: number;
}

export interface YieldPosition {
  id: string;
  ownerAddress: string;
  provider: string;
  providerReference: string;
  label: string;
  tokenMint: string;
  shareMint: string;
  createdAt: string;
  closedAt: string | null;
  shares?: string;
  withdrawableShares?: string;
  tokenValue?: string;
}

export interface YieldQueuedWithdrawalTerms {
  assetMint: string;
  allowWithdrawals: boolean;
  secondsToMaturity: number;
  minimumSecondsToDeadline: number;
  maximumSecondsToDeadline: number;
  minimumDiscountBps: number;
  maximumDiscountBps: number;
  minimumShares: string;
  shareDecimals: number;
}

export interface YieldWithdrawalOptions {
  positionId: string;
  instant: boolean;
  providerOrder: boolean;
  queued: boolean;
  withdrawAuthority: string | null;
  queueState: string | null;
  queueAsset: YieldQueuedWithdrawalTerms | null;
}

export type YieldWithdrawalRequestStatus =
  | "creating"
  | "pending"
  | "fulfillable"
  | "expiredCancelable"
  | "cancelling"
  | "fulfilled"
  | "cancelled"
  | "closedOrUnknown"
  | "failed";

/** A durable queued exit. Request creation escrows shares and pays no assets. */
export interface YieldWithdrawalRequest {
  withdrawalRequestId: string;
  positionId: string;
  provider: string;
  providerReference: string;
  ownerAddress: string;
  requestAddress: string;
  status: YieldWithdrawalRequestStatus;
  assetMint: string;
  shareMint: string;
  shares: string;
  quotedAssets: string;
  shareDecimals: number;
  assetDecimals: number;
  discountBps: number;
  nonce: string | null;
  creationTimestamp: string | null;
  maturityTimestamp: string;
  deadlineTimestamp: string;
  creationSignature: string | null;
  cancelSignature: string | null;
  closingSignature: string | null;
  assetsPaid: string | null;
  failureReason: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  replayed?: boolean;
}

export type WithdrawalIntent =
  | { amount: string; route: "direct" }
  | {
      amount: string;
      route: "queued";
      discountBps: number;
      deadlineSeconds: number;
    };

export type MovementStatus =
  | "requested"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed";

export interface YieldMovement {
  movementId: string;
  positionId: string;
  provider: string;
  providerReference: string;
  direction: "deposit" | "withdrawal";
  status: MovementStatus;
  signature: string;
  /** On-chain quantity: deposit tokens for a deposit, shares for a withdrawal. */
  amount: string;
  denomination: string;
  tokenMint: string;
  /** Deposit-token view: the deposit amount, or a withdrawal's settled payout. */
  tokenAmount: string | null;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount: string;
  decimals: number;
}

export type FeePayer = "customer" | "northstar";

export interface DashboardData {
  wallet: {
    address: string;
    cluster: "devnet" | "mainnet-beta";
    feesPaidBy: FeePayer;
  };
  token: {
    mint: string;
    symbol: string;
  };
  checking: {
    balance: string;
  };
  savings: {
    /** The one Embedded Yield strategy behind the savings account. */
    strategy: YieldStrategy;
    position: YieldPosition | null;
    /** Current value in the account token. Undefined while the provider valuation is unavailable. */
    balance?: string;
    /** Value that can move back to checking right now. */
    withdrawable?: string;
    earned?: string;
    /** Live routes for the current position. Null when absent or unavailable. */
    withdrawalOptions: YieldWithdrawalOptions | null;
  };
  /** Checking plus savings. Undefined while the savings valuation is unavailable. */
  total?: string;
  movements: YieldMovement[];
  /** Every non-terminal queued exit, restored on every dashboard load. */
  withdrawalRequests: YieldWithdrawalRequest[];
  connection: {
    apiLabel: string;
    checkedAt: string;
  };
}

export interface TransferResult {
  movement: YieldMovement;
}

export type WithdrawalResult =
  | { kind: "movement"; movement: YieldMovement }
  | { kind: "queued"; withdrawalRequest: YieldWithdrawalRequest };

export interface WithdrawalCancellationResult {
  withdrawalRequest: YieldWithdrawalRequest;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}
