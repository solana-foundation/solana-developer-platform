import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnMovementDirection,
  EarnMovementStatus,
  EarnPositionStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";

export function generateEarnStrategyId(): string {
  return `earn_strategy_${crypto.randomUUID()}`;
}

export function generateEarnPositionId(): string {
  return `earn_position_${crypto.randomUUID()}`;
}

export function generateEarnMovementId(): string {
  return `earn_movement_${crypto.randomUUID()}`;
}

export function generateEarnNavSnapshotId(): string {
  return `earn_nav_${crypto.randomUUID()}`;
}

export interface EarnStrategyRow {
  id: string;
  provider: EarnProviderId;
  provider_reference: string;
  name: string;
  source_kind: EarnStrategySourceKind;
  underlying_source: string | null;
  deposit_mints: string[];
  share_mint: string | null;
  apy_type: EarnApyType;
  current_apy: string | null;
  liquidity_term: EarnLiquidityTerm;
  redemption_delay_days: number | null;
  risk_metadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  environment: SdpEnvironment;
  created_at: string;
  updated_at: string;
}

export interface EarnPositionRow {
  id: string;
  organization_id: string;
  project_id: string;
  strategy_id: string;
  wallet_id: string;
  share_amount: string;
  cost_basis: string | null;
  status: EarnPositionStatus;
  provider_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EarnMovementRow {
  id: string;
  organization_id: string;
  project_id: string;
  position_id: string;
  strategy_id: string;
  direction: EarnMovementDirection;
  token_mint: string;
  amount: string;
  share_amount: string | null;
  status: EarnMovementStatus;
  transaction_signature: string | null;
  provider: EarnProviderId | null;
  provider_reference: string | null;
  provider_data: Record<string, unknown>;
  external_id: string | null;
  redemption_available_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EarnNavSnapshotRow {
  id: string;
  strategy_id: string;
  share_price: string;
  apy: string | null;
  tvl: string | null;
  as_of: string;
  created_at: string;
}

/** Catalogue sync upsert, keyed on (provider, provider_reference, environment). */
export interface UpsertEarnStrategyInput {
  provider: EarnProviderId;
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource: string | null;
  depositMints: string[];
  shareMint: string | null;
  apyType: EarnApyType;
  currentApy: string | null;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays: number | null;
  riskMetadata: EarnStrategyRiskMetadata;
  status: EarnStrategyStatus;
  environment: SdpEnvironment;
}

export interface ListEarnStrategiesInput {
  environment: SdpEnvironment;
  sourceKind?: EarnStrategySourceKind;
  apyType?: EarnApyType;
  liquidityTerm?: EarnLiquidityTerm;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}

export interface ListEarnStrategiesResult {
  rows: EarnStrategyRow[];
  total: number;
}

export interface CreateEarnPositionInput {
  organizationId: string;
  projectId: string;
  strategyId: string;
  walletId: string;
}

export interface ListEarnPositionsInput {
  organizationId: string;
  projectId: string;
  strategyId?: string;
  includeClosed?: boolean;
  limit: number;
  offset: number;
}

export interface ListEarnPositionsResult {
  rows: EarnPositionRow[];
  total: number;
}

export interface CreateEarnMovementInput {
  organizationId: string;
  projectId: string;
  positionId: string;
  strategyId: string;
  direction: EarnMovementDirection;
  tokenMint: string;
  amount: string;
  shareAmount: string | null;
  provider: EarnProviderId | null;
  providerReference: string | null;
  providerData: Record<string, unknown>;
  externalId: string | null;
  redemptionAvailableAt: string | null;
}

export interface UpdateEarnMovementStatusInput {
  movementId: string;
  organizationId: string;
  projectId: string;
  status: EarnMovementStatus;
  transactionSignature?: string;
  shareAmount?: string;
  redemptionAvailableAt?: string;
}

export interface ListEarnMovementsInput {
  organizationId: string;
  projectId: string;
  positionId?: string;
  direction?: EarnMovementDirection;
  limit: number;
  offset: number;
}

export interface ListEarnMovementsResult {
  rows: EarnMovementRow[];
  total: number;
}

export interface InsertEarnNavSnapshotInput {
  strategyId: string;
  sharePrice: string;
  apy: string | null;
  tvl: string | null;
  asOf: string;
}

export interface EarnRepository {
  upsertStrategy(input: UpsertEarnStrategyInput): Promise<EarnStrategyRow | null>;
  getStrategyById(strategyId: string): Promise<EarnStrategyRow | null>;
  listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult>;

  createPosition(input: CreateEarnPositionInput): Promise<EarnPositionRow | null>;
  getPositionById(params: {
    positionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<EarnPositionRow | null>;
  listPositions(input: ListEarnPositionsInput): Promise<ListEarnPositionsResult>;

  createMovement(input: CreateEarnMovementInput): Promise<EarnMovementRow | null>;
  getMovementById(params: {
    movementId: string;
    organizationId: string;
    projectId: string;
  }): Promise<EarnMovementRow | null>;
  /** Webhook settlement lookup — provider events carry no org/project scope. */
  getMovementByProviderReference(params: {
    provider: EarnProviderId;
    providerReference: string;
  }): Promise<EarnMovementRow | null>;
  updateMovementStatus(input: UpdateEarnMovementStatusInput): Promise<EarnMovementRow | null>;
  listMovements(input: ListEarnMovementsInput): Promise<ListEarnMovementsResult>;

  insertNavSnapshot(input: InsertEarnNavSnapshotInput): Promise<EarnNavSnapshotRow | null>;
  listNavSnapshots(params: { strategyId: string; limit: number }): Promise<EarnNavSnapshotRow[]>;
}
