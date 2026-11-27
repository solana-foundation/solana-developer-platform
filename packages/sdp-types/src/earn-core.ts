import type {
  EarnStrategy,
  EarnVaultPosition,
  EarnVaultPositionsPage,
  EarnWalletPosition,
  EarnWalletPositionSummary,
  EarnWalletStrategyTotal,
} from "./earn";

/** A strategy with explicit rate provenance and adapter capabilities. */
export interface EarnCoreStrategy extends EarnStrategy {
  rate: {
    /** Decimal fraction, for example 0.062 means 6.2 percent APY. */
    value: string | null;
    measure: "apy";
    basis: "provider_reported";
    /** Null for legacy rates whose observation time is unknown. */
    observedAt: string | null;
    source: { provider: string; providerReference: string };
  };
  /** Adapter support is separate from per-wallet transaction admission. */
  capabilities: {
    deposit: boolean;
    withdraw: boolean;
    admission: "evaluated_on_prepare";
    depositUnavailableReason?: "catalogue_only" | "adapter_unavailable";
  };
}

/** The paginated catalogue of validated, ingested strategies. */
export interface EarnDiscoveryResponse {
  strategies: EarnCoreStrategy[];
  total: number;
  page: number;
  pageSize: number;
}

/** A holding's funding identity, independent of the product using Earn. */
export type EarnPositionSource = { walletId: string } | { ownerAddress: string };

/** One live holding, using the existing stable position ID. */
export interface EarnCorePosition extends Omit<EarnVaultPosition, "custodyWalletId" | "createdAt"> {
  source: EarnPositionSource;
  /** Absent when the catalogue no longer contains the held instrument. */
  strategyId?: string;
  /** Discovery cannot infer when an untracked wallet acquired the holding. */
  createdAt: string | null;
  discovered?: boolean;
  /** Unknown acquisition history withholds earned amounts, including after import. */
  costBasisKnown: boolean;
  /** Slot floor for refreshing the funding balance alongside this holding. */
  balanceReadContext?: EarnVaultPositionsPage["balanceReadContext"];
}

/** Summary values retain their units and unknown discovered acquisition dates. */
export interface EarnCorePositionSummary
  extends Omit<EarnWalletPositionSummary, "totalsByStrategy"> {
  costBasisCoverage: "complete" | "unknown";
  unknownCostBasisPositionCount: number;
  totalsByStrategy: Array<
    Omit<EarnWalletStrategyTotal, "positions"> & {
      positions?: Array<
        Omit<EarnWalletPosition, "createdAt"> & {
          createdAt: string | null;
          discovered?: boolean;
        }
      >;
    }
  >;
}

/** One page of visible positions and an optional complete-scope summary. */
export interface EarnPositionsResponse {
  positions: EarnCorePosition[];
  hasMore: boolean;
  nextCursor: string | null;
  balanceReadContext?: EarnVaultPositionsPage["balanceReadContext"];
  /** Complete selected scope, never a total over only the current page. */
  summary?: EarnCorePositionSummary;
  /** Previously unseen onchain holdings are not imported by this read. */
  coverage: "sdp_tracked_positions" | "integrated_catalogue_positions";
  discovery?: {
    strategyCount: number;
    /** Strategies with missing or unavailable live observations, never assumed empty. */
    unavailableStrategyCount: number;
  };
}
