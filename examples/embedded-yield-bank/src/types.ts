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
  amount: string;
  denomination: string;
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

export interface DashboardData {
  wallet: {
    address: string;
    solBalance: string;
    cluster: "devnet";
  };
  balances: TokenBalance[];
  strategies: YieldStrategy[];
  positions: YieldPosition[];
  movements: YieldMovement[];
  earnings: TokenEarnings[];
  totals: {
    available: string;
    inYield?: string;
    portfolio?: string;
    earned?: string;
    unavailableYieldPositions: number;
  };
  connection: {
    apiLabel: string;
    projectScoped: boolean;
    checkedAt: string;
  };
}

export interface MoneyMovementResult {
  movement: YieldMovement;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}
