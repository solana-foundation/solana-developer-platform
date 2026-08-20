import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnPortfolioToken,
  EarnProgramWithdrawalRecordStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
  SolanaCluster,
} from "@sdp/types";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types";
import { type AppDb, asTransactionalClient } from "@/db";
import type {
  CreateEarnProgramWithdrawalInput,
  DeleteUnlistedEarnStrategiesInput,
  EarnProgramWithdrawalRow,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProviderWalletInput,
  ListEarnProgramWithdrawalsInput,
  ListEarnProgramWithdrawalsResult,
  ListEarnProviderWalletsInput,
  ListEarnProviderWalletsResult,
  ListEarnStrategiesInput,
  ListEarnStrategiesResult,
  UpdateEarnProgramWithdrawalStatusGuardedInput,
  UpdateEarnStrategyMetricsInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import {
  generateEarnProgramWithdrawalId,
  generateEarnProviderWalletId,
  generateEarnStrategyId,
} from "./earn.repository";
import {
  mintEarnPositionForProviderWallet,
  projectEarnMovementFromWithdrawal,
} from "./earn-movements.repository";

/**
 * `host_cluster` is NULLABLE in the schema on purpose (migration 0057 is the
 * expand half of an expand/contract rollout), so the read has to answer for a
 * row an older writer left unset. It answers with the environment's own
 * cluster — the same rule the migration's backfill applies, and true of every
 * writer that predates the column: Ground's catalogue gate only ever admits a
 * source hosted on the environment's own chain.
 *
 * Failing closed here instead would be worse than useless: a NULL row would
 * come back un-fundable, so a mid-deploy or rolled-back write would quietly
 * drop live Ground strategies out of the wizard. Reading the fact that IS
 * known keeps such a row correct until the next sync states it explicitly.
 */
function mapStrategyRow(row: Record<string, unknown>): EarnStrategyRow {
  const environment = row.environment as SdpEnvironment;
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
    host_cluster:
      (row.host_cluster as SolanaCluster | null) ?? CLUSTER_BY_SDP_ENVIRONMENT[environment],
    environment,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapProviderWalletRow(row: Record<string, unknown>): EarnProviderWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
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
/**
 * `order` picks the direction of the (created_at, id) sort — id is always the
 * tiebreaker because bulk rows share sdp_iso_now(). DESC (newest first) is the
 * default every history list wants. Programs pass ASC deliberately: the head of
 * that list must not move when a new program is created (migration 0056's
 * header explains what breaks if it does).
 */
async function selectPage<Row>(
  db: AppDb,
  table: "earn_strategies" | "earn_program_withdrawals" | "earn_provider_wallets",
  conditions: string[],
  bindings: unknown[],
  window: { limit: number; offset: number },
  mapRow: (row: Record<string, unknown>) => Row,
  order: "ASC" | "DESC" = "DESC"
): Promise<{ rows: Row[]; total: number }> {
  const where = conditions.join(" AND ");

  const [page, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM ${table}
           WHERE ${where}
           ORDER BY created_at ${order}, id ${order}
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
             risk_metadata, status, host_cluster, environment
           ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
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
             host_cluster = EXCLUDED.host_cluster,
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
          input.hostCluster,
          input.environment
        )
        .first<Record<string, unknown>>();

      return row ? mapStrategyRow(row) : null;
    },

    async updateStrategyMetrics(input: UpdateEarnStrategyMetricsInput) {
      // `||` merges the incoming keys over the stored object, so a refresh that
      // reports only tvlUsd and holders leaves curator (which the hourly sync
      // derives) exactly as it was. A plain assignment here would silently
      // strip every field the refresh does not carry.
      //
      // No status predicate: refreshing an operator-PAUSED row's rate is
      // correct — the pause stops deposits, it does not freeze the vault's
      // real-world numbers, and an operator deciding whether to unpause wants
      // the current figures, not the ones from the moment they stopped it.
      const row = await db
        .prepare(
          `UPDATE earn_strategies
              SET current_apy = ?,
                  risk_metadata = risk_metadata || ?::jsonb,
                  updated_at = sdp_iso_now()
            WHERE provider = ? AND provider_reference = ? AND environment = ?
            RETURNING id`
        )
        .bind(
          input.currentApy,
          JSON.stringify(input.riskMetadata ?? {}),
          input.provider,
          input.providerReference,
          input.environment
        )
        .first<Record<string, unknown>>();
      return row !== null && row !== undefined;
    },

    async getStrategyById(strategyId: string) {
      const row = await db
        .prepare(`SELECT * FROM earn_strategies WHERE id = ?`)
        .bind(strategyId)
        .first<Record<string, unknown>>();
      return row ? mapStrategyRow(row) : null;
    },

    async deleteUnlistedStrategies(input: DeleteUnlistedEarnStrategiesInput) {
      // Only `active` rows are deleted. An operator `paused`/`deprecated` is a
      // deliberate human record, and it is load-bearing: upsertStrategy refuses
      // to overwrite it precisely so a vault stopped for an exploit or depeg
      // cannot be silently reactivated by a sync. Deleting such a row would
      // discard that guard — the next time the provider listed the reference, it
      // would be inserted fresh as `active`. So an operator-stopped row is the
      // one thing this pass leaves behind; it is invisible to every read anyway
      // (the catalogue and program-creation paths both filter `status = 'active'`).
      //
      // An empty keep set would match EVERY active row (`= ANY('{}')` is false,
      // so `NOT` admits everything) and delete the provider's whole shelf.
      // "The provider listed nothing" is indistinguishable from a misconfigured
      // account or a silently-empty response, so it can never trigger a
      // catalogue-wide teardown.
      if (input.listedProviderReferences.length === 0) {
        return [];
      }

      const rows = await db
        .prepare(
          `DELETE FROM earn_strategies
            WHERE provider = ?
              AND environment = ?
              AND status = 'active'
              AND NOT (provider_reference = ANY(?))
            RETURNING provider_reference`
        )
        .bind(input.provider, input.environment, [...input.listedProviderReferences])
        .all<{ provider_reference: string }>();

      return (rows.results ?? []).map((row) => row.provider_reference);
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
      if (input.providers !== undefined) {
        if (input.providers.length === 0) {
          // `provider IN ()` is a syntax error, and falling through to "no
          // filter" would surface EVERY provider the moment the offered set went
          // empty — the exact inversion this filter exists to prevent.
          conditions.push("1 = 0");
        } else {
          conditions.push(`provider IN (${input.providers.map(() => "?").join(", ")})`);
          bindings.push(...input.providers);
        }
      }
      if (input.excludeProviderKeys?.length) {
        const placeholders = input.excludeProviderKeys.map(() => "?").join(", ");
        // Concatenated so one binding list covers both halves of the key; a bare
        // provider_reference match could hide another provider's vault that
        // happens to share a reference.
        conditions.push(`(provider || ':' || provider_reference) NOT IN (${placeholders})`);
        bindings.push(...input.excludeProviderKeys);
      }
      for (const [provider, references] of Object.entries(input.allowedProviderReferences ?? {})) {
        if (references.length === 0) {
          conditions.push("provider <> ?");
          bindings.push(provider);
          continue;
        }
        // Scoped to the one provider: every other provider's rows pass through,
        // so adding an allowlist for one shelf never silently curates another.
        const placeholders = references.map(() => "?").join(", ");
        conditions.push(`(provider <> ? OR provider_reference IN (${placeholders}))`);
        bindings.push(provider, ...references);
      }
      for (const rawTerm of input.excludeRelatedTerms ?? []) {
        const term = rawTerm.trim().toLowerCase();
        if (!term) continue;
        const pattern = `%${term}%`;
        conditions.push(
          `(LOWER(provider_reference) NOT LIKE ?
            AND LOWER(name) NOT LIKE ?
            AND LOWER(COALESCE(underlying_source, '')) NOT LIKE ?)`
        );
        bindings.push(pattern, pattern, pattern);
      }

      return selectPage(db, "earn_strategies", conditions, bindings, input, mapStrategyRow);
    },

    async getProviderWalletById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE organization_id = ? AND environment = ? AND id = ?`
        )
        .bind(params.organizationId, params.environment, params.walletId)
        .first<Record<string, unknown>>();
      return row ? mapProviderWalletRow(row) : null;
    },

    async listProviderWallets(
      input: ListEarnProviderWalletsInput
    ): Promise<ListEarnProviderWalletsResult> {
      const conditions = ["organization_id = ?", "environment = ?"];
      const bindings: unknown[] = [input.organizationId, input.environment];

      if (input.provider) {
        conditions.push("provider = ?");
        bindings.push(input.provider);
      }

      // ASC: oldest first, so the head of the list is stable for a program's
      // whole life (migration 0056).
      return selectPage(
        db,
        "earn_provider_wallets",
        conditions,
        bindings,
        input,
        mapProviderWalletRow,
        "ASC"
      );
    },

    async getProviderWalletByRef(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE provider = ? AND provider_wallet_ref = ?`
        )
        .bind(params.provider, params.providerWalletRef)
        .first<Record<string, unknown>>();
      return row ? mapProviderWalletRow(row) : null;
    },

    async insertProviderWallet(input: InsertEarnProviderWalletInput) {
      const id = generateEarnProviderWalletId();

      // Linking a program also opens its custodial HOLDING in the unified
      // ledger, atomically. Without it the program's first withdrawal would have
      // no position to belong to, and the ledger requires every movement to have
      // one (PRO-1705). 0064 does the same for programs that already exist.
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const row = await transaction
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
        if (!row) return null;

        await mintEarnPositionForProviderWallet(transaction, id);
        return mapProviderWalletRow(row);
      });
    },

    async createProgramWithdrawal(input: CreateEarnProgramWithdrawalInput) {
      const id = generateEarnProgramWithdrawalId();

      // Status comes from the DB default ('requested'): an intent row exists
      // before the provider call is accepted, never in any other state.
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const row = await transaction
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
        if (!row) return null;

        await projectEarnMovementFromWithdrawal(transaction, id);
        return mapProgramWithdrawalRow(row);
      });
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

      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const row = await transaction
          .prepare(
            `UPDATE earn_program_withdrawals
             SET ${assignments.join(", ")}
           WHERE ${conditions.join(" AND ")}
           RETURNING *`
          )
          .bind(...assignmentValues, ...conditionValues)
          .first<Record<string, unknown>>();
        // A lost CAS wrote nothing, so there is nothing to mirror: the winner
        // already projected the state it moved the row to.
        if (!row) return null;

        await projectEarnMovementFromWithdrawal(transaction, row.id as string);
        return mapProgramWithdrawalRow(row);
      });
    },

    async listProgramWithdrawals(
      input: ListEarnProgramWithdrawalsInput
    ): Promise<ListEarnProgramWithdrawalsResult> {
      // Wallet-scoped, not (org, project): every project in the environment
      // reaches the same programs, and since PRO-1670 an organization may hold
      // several — so the wallet id is what both joins sibling projects' history
      // and keeps a sibling PROGRAM's payouts out. One program = one history.
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
