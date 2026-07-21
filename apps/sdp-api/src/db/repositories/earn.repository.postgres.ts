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
import type { AppDb } from "@/db";
import type {
  CreateEarnMovementInput,
  CreateEarnPositionInput,
  EarnMovementRow,
  EarnNavSnapshotRow,
  EarnPositionRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnNavSnapshotInput,
  ListEarnMovementsInput,
  ListEarnMovementsResult,
  ListEarnPositionsInput,
  ListEarnPositionsResult,
  ListEarnStrategiesInput,
  ListEarnStrategiesResult,
  UpdateEarnMovementStatusInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import {
  generateEarnMovementId,
  generateEarnNavSnapshotId,
  generateEarnPositionId,
  generateEarnStrategyId,
} from "./earn.repository";

function mapStrategyRow(row: Record<string, unknown>): EarnStrategyRow {
  return {
    id: row.id as string,
    provider: row.provider as EarnProviderId,
    provider_reference: row.provider_reference as string,
    name: row.name as string,
    source_kind: row.source_kind as EarnStrategySourceKind,
    underlying_source: row.underlying_source as string | null,
    deposit_mints: row.deposit_mints as string[],
    share_mint: row.share_mint as string | null,
    apy_type: row.apy_type as EarnApyType,
    current_apy: row.current_apy as string | null,
    liquidity_term: row.liquidity_term as EarnLiquidityTerm,
    redemption_delay_days: row.redemption_delay_days as number | null,
    risk_metadata: row.risk_metadata as EarnStrategyRiskMetadata,
    status: row.status as EarnStrategyStatus,
    environment: row.environment as SdpEnvironment,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapPositionRow(row: Record<string, unknown>): EarnPositionRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    strategy_id: row.strategy_id as string,
    wallet_id: row.wallet_id as string,
    share_amount: row.share_amount as string,
    cost_basis: row.cost_basis as string | null,
    status: row.status as EarnPositionStatus,
    provider_data: row.provider_data as Record<string, unknown>,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapMovementRow(row: Record<string, unknown>): EarnMovementRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    position_id: row.position_id as string,
    strategy_id: row.strategy_id as string,
    direction: row.direction as EarnMovementDirection,
    token_mint: row.token_mint as string,
    amount: row.amount as string,
    share_amount: row.share_amount as string | null,
    status: row.status as EarnMovementStatus,
    transaction_signature: row.transaction_signature as string | null,
    provider: row.provider as EarnProviderId | null,
    provider_reference: row.provider_reference as string | null,
    provider_data: row.provider_data as Record<string, unknown>,
    external_id: row.external_id as string | null,
    redemption_available_at: row.redemption_available_at as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapNavSnapshotRow(row: Record<string, unknown>): EarnNavSnapshotRow {
  return {
    id: row.id as string,
    strategy_id: row.strategy_id as string,
    share_price: row.share_price as string,
    apy: row.apy as string | null,
    tvl: row.tvl as string | null,
    as_of: row.as_of as string,
    created_at: row.created_at as string,
  };
}

export function createPostgresEarnRepository(db: AppDb): EarnRepository {
  return {
    async upsertStrategy(input: UpsertEarnStrategyInput) {
      const id = generateEarnStrategyId();

      const row = await db
        .prepare(
          `INSERT INTO earn_strategies (
             id, provider, provider_reference, name,
             source_kind, underlying_source, deposit_mints, share_mint,
             apy_type, current_apy, liquidity_term, redemption_delay_days,
             risk_metadata, status, environment
           ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
           ON CONFLICT (provider, provider_reference, environment) DO UPDATE SET
             name = EXCLUDED.name,
             source_kind = EXCLUDED.source_kind,
             underlying_source = EXCLUDED.underlying_source,
             deposit_mints = EXCLUDED.deposit_mints,
             share_mint = EXCLUDED.share_mint,
             apy_type = EXCLUDED.apy_type,
             current_apy = EXCLUDED.current_apy,
             liquidity_term = EXCLUDED.liquidity_term,
             redemption_delay_days = EXCLUDED.redemption_delay_days,
             risk_metadata = EXCLUDED.risk_metadata,
             status = EXCLUDED.status,
             updated_at = sdp_iso_now()
           RETURNING *`
        )
        .bind(
          id,
          input.provider,
          input.providerReference,
          input.name,
          input.sourceKind,
          input.underlyingSource,
          JSON.stringify(input.depositMints),
          input.shareMint,
          input.apyType,
          input.currentApy,
          input.liquidityTerm,
          input.redemptionDelayDays,
          JSON.stringify(input.riskMetadata ?? {}),
          input.status,
          input.environment
        )
        .first<Record<string, unknown>>();

      return row ? mapStrategyRow(row) : null;
    },

    async getStrategyById(strategyId: string) {
      const row = await db
        .prepare(`SELECT * FROM earn_strategies WHERE id = ?`)
        .bind(strategyId)
        .first<Record<string, unknown>>();
      return row ? mapStrategyRow(row) : null;
    },

    async listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult> {
      const conditions = ["environment = ?"];
      const bindings: unknown[] = [input.environment];

      if (!input.includeInactive) {
        conditions.push("status = 'active'");
      }
      if (input.sourceKind) {
        conditions.push("source_kind = ?");
        bindings.push(input.sourceKind);
      }
      if (input.apyType) {
        conditions.push("apy_type = ?");
        bindings.push(input.apyType);
      }
      if (input.liquidityTerm) {
        conditions.push("liquidity_term = ?");
        bindings.push(input.liquidityTerm);
      }

      const where = conditions.join(" AND ");

      const countRow = await db
        .prepare(`SELECT COUNT(*) AS total FROM earn_strategies WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number | string }>();

      const { results } = await db
        .prepare(
          `SELECT * FROM earn_strategies
             WHERE ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(...bindings, input.limit, input.offset)
        .all<Record<string, unknown>>();

      return {
        rows: (results ?? []).map(mapStrategyRow),
        total: Number(countRow?.total ?? 0),
      };
    },

    async createPosition(input: CreateEarnPositionInput) {
      const id = generateEarnPositionId();

      const row = await db
        .prepare(
          `INSERT INTO earn_positions (
             id, organization_id, project_id, strategy_id, wallet_id
           ) VALUES (?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(id, input.organizationId, input.projectId, input.strategyId, input.walletId)
        .first<Record<string, unknown>>();

      return row ? mapPositionRow(row) : null;
    },

    async getPositionById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_positions
             WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(params.positionId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapPositionRow(row) : null;
    },

    async listPositions(input: ListEarnPositionsInput): Promise<ListEarnPositionsResult> {
      const conditions = ["organization_id = ?", "project_id = ?"];
      const bindings: unknown[] = [input.organizationId, input.projectId];

      if (!input.includeClosed) {
        conditions.push("status = 'active'");
      }
      if (input.strategyId) {
        conditions.push("strategy_id = ?");
        bindings.push(input.strategyId);
      }

      const where = conditions.join(" AND ");

      const countRow = await db
        .prepare(`SELECT COUNT(*) AS total FROM earn_positions WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number | string }>();

      const { results } = await db
        .prepare(
          `SELECT * FROM earn_positions
             WHERE ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(...bindings, input.limit, input.offset)
        .all<Record<string, unknown>>();

      return {
        rows: (results ?? []).map(mapPositionRow),
        total: Number(countRow?.total ?? 0),
      };
    },

    async createMovement(input: CreateEarnMovementInput) {
      const id = generateEarnMovementId();

      const row = await db
        .prepare(
          `INSERT INTO earn_movements (
             id, organization_id, project_id, position_id, strategy_id,
             direction, token_mint, amount, share_amount,
             provider, provider_reference, provider_data,
             external_id, redemption_available_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.positionId,
          input.strategyId,
          input.direction,
          input.tokenMint,
          input.amount,
          input.shareAmount,
          input.provider,
          input.providerReference,
          JSON.stringify(input.providerData ?? {}),
          input.externalId,
          input.redemptionAvailableAt
        )
        .first<Record<string, unknown>>();

      return row ? mapMovementRow(row) : null;
    },

    async getMovementById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(params.movementId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async getMovementByProviderReference(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE provider = ? AND provider_reference = ?`
        )
        .bind(params.provider, params.providerReference)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async updateMovementStatus(input: UpdateEarnMovementStatusInput) {
      const row = await db
        .prepare(
          `UPDATE earn_movements
             SET status = ?,
                 transaction_signature = COALESCE(?, transaction_signature),
                 share_amount = COALESCE(?, share_amount),
                 redemption_available_at = COALESCE(?, redemption_available_at),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
           RETURNING *`
        )
        .bind(
          input.status,
          input.transactionSignature ?? null,
          input.shareAmount ?? null,
          input.redemptionAvailableAt ?? null,
          input.movementId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapMovementRow(row) : null;
    },

    async listMovements(input: ListEarnMovementsInput): Promise<ListEarnMovementsResult> {
      const conditions = ["organization_id = ?", "project_id = ?"];
      const bindings: unknown[] = [input.organizationId, input.projectId];

      if (input.positionId) {
        conditions.push("position_id = ?");
        bindings.push(input.positionId);
      }
      if (input.direction) {
        conditions.push("direction = ?");
        bindings.push(input.direction);
      }

      const where = conditions.join(" AND ");

      const countRow = await db
        .prepare(`SELECT COUNT(*) AS total FROM earn_movements WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number | string }>();

      const { results } = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`
        )
        .bind(...bindings, input.limit, input.offset)
        .all<Record<string, unknown>>();

      return {
        rows: (results ?? []).map(mapMovementRow),
        total: Number(countRow?.total ?? 0),
      };
    },

    async insertNavSnapshot(input: InsertEarnNavSnapshotInput) {
      const id = generateEarnNavSnapshotId();

      const row = await db
        .prepare(
          `INSERT INTO earn_nav_snapshots (
             id, strategy_id, share_price, apy, tvl, as_of
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (strategy_id, as_of) DO UPDATE SET
             share_price = EXCLUDED.share_price,
             apy = EXCLUDED.apy,
             tvl = EXCLUDED.tvl
           RETURNING *`
        )
        .bind(id, input.strategyId, input.sharePrice, input.apy, input.tvl, input.asOf)
        .first<Record<string, unknown>>();

      return row ? mapNavSnapshotRow(row) : null;
    },

    async listNavSnapshots(params) {
      const { results } = await db
        .prepare(
          `SELECT * FROM earn_nav_snapshots
             WHERE strategy_id = ?
             ORDER BY as_of DESC
             LIMIT ?`
        )
        .bind(params.strategyId, params.limit)
        .all<Record<string, unknown>>();

      return (results ?? []).map(mapNavSnapshotRow);
    },
  };
}
