export interface YieldStrategy {
  id: string;
  provider: string;
  providerReference: string;
  name: string;
  sourceKind: "defi" | "rwa";
  depositMints: string[];
  shareMint?: string;
  currentApy?: string;
  rate?: {
    value: string | null;
    measure: "apy";
    basis: "provider_reported";
    observedAt: string | null;
    source: { provider: string; providerReference: string };
  };
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
  discovered?: boolean;
  costBasisKnown?: boolean;
  id: string;
  ownerAddress: string;
  provider: string;
  providerReference: string;
  label: string;
  tokenMint: string;
  shareMint: string;
  createdAt: string | null;
  closedAt: string | null;
  shares?: string;
  tokenValue?: string;
}

export interface WithdrawalIntent {
  amount: string;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount: string;
  decimals: number;
}

export interface DashboardData {
  wallet: {
    address: string;
    cluster: "devnet" | "mainnet-beta";
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
    earned?: string;
  };
  /** Checking plus savings. Undefined while the savings valuation is unavailable. */
  total?: string;
  operations: import("./lib/core-operation").EarnOperation[];
  connection: {
    apiLabel: string;
    checkedAt: string;
  };
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}
