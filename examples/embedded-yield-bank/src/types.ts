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

export interface TokenEarnings {
  tokenMint: string;
  positionCount: number;
  unavailablePositionCount: number;
  currentValue?: string;
  totalDeposited: string;
  earned?: string;
  earnedUnavailableReason?: string;
}

export type FeePayer = "customer" | "northstar";

export interface DashboardData {
  wallet: {
    address: string;
    cluster: "devnet";
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
  };
  /** Checking plus savings. Undefined while the savings valuation is unavailable. */
  total?: string;
  movements: YieldMovement[];
  connection: {
    apiLabel: string;
    checkedAt: string;
  };
}

export interface TransferResult {
  movement: YieldMovement;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}
