import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnPortfolioToken,
  EarnProgramWithdrawalRecordStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
} from "@sdp/types";
import type { AppDb } from "@/db";
import type {
  CreateEarnProgramWithdrawalInput,
  EarnProgramWithdrawalRow,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProviderWalletInput,
  ListEarnProgramWithdrawalsInput,
  ListEarnProgramWithdrawalsResult,
  ListEarnStrategiesInput,
  ListEarnStrategiesResult,
  UpdateEarnProgramWithdrawalStatusGuardedInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import {
  generateEarnProgramWithdrawalId,
  generateEarnProviderWalletId,
  generateEarnStrategyId,
} from "./earn.repository";

function mapStrategyRow(row: Record<string, unknown>): EarnStrategyRow {
  return {
    id: row.id as string,
    provider: row.provider as string,
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

function mapProviderWalletRow(row: Record<string, unknown>): EarnProviderWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    environment: row.environment as SdpEnvironment,
    provider: row.provider as string,
    provider_wallet_ref: row.provider_wallet_ref as string,
    label: row.label as string | null,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapProgramWithdrawalRow(row: Record<string, unknown>): EarnProgramWithdrawalRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    wallet_id: row.wallet_id as string,
    provider: row.provider as string,
    status: row.status as EarnProgramWithdrawalRecordStatus,
    amount_requested_usd: row.amount_requested_usd as string,
    amount_paid_usd: row.amount_paid_usd as string | null,
    fee_usd: row.fee_usd as string | null,
    token: row.token as EarnPortfolioToken,
    destination_address: row.destination_address as string,
    failure_reason: row.failure_reason as string | null,
    request_id: row.request_id as string,
    idempotency_fingerprint: row.idempotency_fingerprint as string,
    provider_reference: row.provider_reference as string | null,
    provider_data: row.provider_data as Record<string, unknown>,
    created_by: row.created_by as string | null,
    initiated_by_key_id: row.initiated_by_key_id as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: row.completed_at as string | null,
  };
}

/**
 * Shared count+page read for the earn list methods (same shape as the
 * payments-family where-builder idiom). Ordering is fixed at newest-first with
 * id as the deterministic tiebreaker — bulk catalogue syncs write many rows in
 * the same instant, so created_at alone would make pages unstable.
 */
async function selectPage<Row>(
  db: AppDb,
  table: "earn_strategies" | "earn_program_withdrawals",
  conditions: string[],
  bindings: unknown[],
  window: { limit: number; offset: number },
  mapRow: (row: Record<string, unknown>) => Row
): Promise<{ rows: Row[]; total: number }> {
  const where = conditions.join(" AND ");

  const [page, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM ${table}
           WHERE ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`
      )
      .bind(...bindings, window.limit, window.offset)
      .all<Record<string, unknown>>(),
    db
      .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    rows: (page.results ?? []).map(mapRow),
    total: countRow?.total ?? 0,
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
             -- An operator pause/deprecation outranks the provider catalogue.
             -- The hourly sync always upserts 'active' for anything a provider
             -- still lists, so overwriting status here would silently unpause a
             -- strategy stopped for an exploit or depeg within the hour and let
             -- deposits resume. Reactivation is therefore deliberate: metadata
             -- and rates keep flowing, but leaving paused/deprecated takes an
             -- explicit status write, never a sync.
             status = CASE
               WHEN earn_strategies.status IN ('paused', 'deprecated')
                 THEN earn_strategies.status
               ELSE EXCLUDED.status
             END,
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

      return selectPage(db, "earn_strategies", conditions, bindings, input, mapStrategyRow);
    },

    async getProviderWallet(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE organization_id = ? AND environment = ? AND provider = ?`
        )
        .bind(params.organizationId, params.environment, params.provider)
        .first<Record<string, unknown>>();
      return row ? mapProviderWalletRow(row) : null;
    },

    async insertProviderWallet(input: InsertEarnProviderWalletInput) {
      const id = generateEarnProviderWalletId();

      const row = await db
        .prepare(
          `INSERT INTO earn_provider_wallets (
             id, organization_id, project_id, environment,
             provider, provider_wallet_ref, label, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.provider,
          input.providerWalletRef,
          input.label,
          input.createdBy
        )
        .first<Record<string, unknown>>();

      return row ? mapProviderWalletRow(row) : null;
    },

    async createProgramWithdrawal(input: CreateEarnProgramWithdrawalInput) {
      const id = generateEarnProgramWithdrawalId();

      // Status comes from the DB default ('requested'): an intent row exists
      // before the provider call is accepted, never in any other state.
      const row = await db
        .prepare(
          `INSERT INTO earn_program_withdrawals (
             id, organization_id, project_id, wallet_id, provider,
             amount_requested_usd, token, destination_address,
             request_id, idempotency_fingerprint, provider_data,
             created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.walletId,
          input.provider,
          input.amountRequestedUsd,
          input.token,
          input.destinationAddress,
          input.requestId,
          input.idempotencyFingerprint,
          JSON.stringify(input.providerData ?? {}),
          input.createdBy,
          input.initiatedByKeyId
        )
        .first<Record<string, unknown>>();

      return row ? mapProgramWithdrawalRow(row) : null;
    },

    async getProgramWithdrawalByRequestId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_program_withdrawals
             WHERE organization_id = ? AND wallet_id = ? AND request_id = ?`
        )
        .bind(params.organizationId, params.walletId, params.requestId)
        .first<Record<string, unknown>>();
      return row ? mapProgramWithdrawalRow(row) : null;
    },

    async getProgramWithdrawalByProviderReference(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_program_withdrawals
             WHERE provider = ? AND provider_reference = ?`
        )
        .bind(params.provider, params.providerReference)
        .first<Record<string, unknown>>();
      return row ? mapProgramWithdrawalRow(row) : null;
    },

    async updateProgramWithdrawalStatusGuarded(
      input: UpdateEarnProgramWithdrawalStatusGuardedInput
    ) {
      // Dynamic SET list, payments idiom: `undefined` means "don't touch",
      // `null` is a real write; provider_data is a shallow JSONB merge.
      // updated_at is DB-stamped (earn convention), never caller-supplied.
      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const assignmentValues: unknown[] = [input.toStatus];
      if (input.providerReference !== undefined) {
        assignments.push("provider_reference = ?");
        assignmentValues.push(input.providerReference);
      }
      if (input.amountPaidUsd !== undefined) {
        assignments.push("amount_paid_usd = ?");
        assignmentValues.push(input.amountPaidUsd);
      }
      if (input.feeUsd !== undefined) {
        assignments.push("fee_usd = ?");
        assignmentValues.push(input.feeUsd);
      }
      if (input.failureReason !== undefined) {
        assignments.push("failure_reason = ?");
        assignmentValues.push(input.failureReason);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        assignmentValues.push(input.completedAt);
      }
      if (input.providerData !== undefined) {
        assignments.push("provider_data = provider_data || ?::jsonb");
        assignmentValues.push(JSON.stringify(input.providerData));
      }

      // The CAS guard and the org scope live in the same WHERE as the selector,
      // so the whole transition is one atomic statement: the loser of a
      // concurrent race simply matches zero rows.
      const conditions = ["organization_id = ?", "status = ANY(?)"];
      const conditionValues: unknown[] = [input.organizationId, [...input.fromStatuses]];
      if ("withdrawalId" in input.selector) {
        conditions.push("id = ?");
        conditionValues.push(input.selector.withdrawalId);
      } else {
        conditions.push("provider = ?", "provider_reference = ?");
        conditionValues.push(input.selector.provider, input.selector.providerReference);
      }

      const row = await db
        .prepare(
          `UPDATE earn_program_withdrawals
             SET ${assignments.join(", ")}
           WHERE ${conditions.join(" AND ")}
           RETURNING *`
        )
        .bind(...assignmentValues, ...conditionValues)
        .first<Record<string, unknown>>();

      return row ? mapProgramWithdrawalRow(row) : null;
    },

    async listProgramWithdrawals(
      input: ListEarnProgramWithdrawalsInput
    ): Promise<ListEarnProgramWithdrawalsResult> {
      // Wallet-scoped, not (org, project): the program wallet is shared by
      // every project in the environment, so one program = one history.
      const conditions = ["organization_id = ?", "wallet_id = ?"];
      const bindings: unknown[] = [input.organizationId, input.walletId];

      return selectPage(
        db,
        "earn_program_withdrawals",
        conditions,
        bindings,
        input,
        mapProgramWithdrawalRow
      );
    },
  };
}
