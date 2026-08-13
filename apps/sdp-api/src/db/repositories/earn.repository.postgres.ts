import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnMovementDirection,
  EarnMovementObservationSource,
  EarnPortfolioToken,
  EarnProgramMovementRecordStatus,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
} from "@sdp/types";
import type { AppDb } from "@/db";
import { toMovementTimestamp } from "@/db/movement-timestamp";
import type {
  CreateEarnProgramWithdrawalInput,
  DeleteUnlistedEarnStrategiesInput,
  EarnProgramDepositRow,
  EarnProgramMovementRow,
  EarnProgramWithdrawalRow,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProgramDepositInput,
  InsertEarnProviderWalletInput,
  ListEarnProgramMovementsInput,
  ListEarnProgramMovementsResult,
  ListEarnProgramWithdrawalsInput,
  ListEarnProgramWithdrawalsResult,
  ListEarnProviderWalletsInput,
  ListEarnProviderWalletsResult,
  ListEarnStrategiesInput,
  ListEarnStrategiesResult,
  ScanEarnProviderWalletsInput,
  SumEarnProgramMovementsInput,
  UpdateEarnProgramDepositStatusGuardedInput,
  UpdateEarnProgramWithdrawalStatusGuardedInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import {
  EARN_SEED_REFERENCE_PREFIX,
  generateEarnProgramDepositId,
  generateEarnProgramWithdrawalId,
  generateEarnProviderWalletId,
  generateEarnStrategyId,
} from "./earn.repository";

/**
 * Movements that actually moved money, for period netting. `partially_completed`
 * counts because a partial payout moved a real amount — which is exactly why the
 * sum reads amount_paid_usd rather than the requested figure.
 */
const DEFAULT_SETTLED_MOVEMENT_STATUSES = [
  "completed",
  "partially_completed",
] as const satisfies readonly EarnProgramMovementRecordStatus[];

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

/** Columns both movement arms share (migration 0057). */
function mapMovementCommon(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    wallet_id: row.wallet_id as string,
    provider: row.provider as string,
    status: row.status as EarnProgramMovementRecordStatus,
    amount_paid_usd: row.amount_paid_usd as string | null,
    fee_usd: row.fee_usd as string | null,
    token: row.token as EarnPortfolioToken,
    failure_reason: row.failure_reason as string | null,
    provider_reference: row.provider_reference as string | null,
    provider_data: row.provider_data as Record<string, unknown>,
    created_by: row.created_by as string | null,
    initiated_by_key_id: row.initiated_by_key_id as string | null,
    observed_via: row.observed_via as EarnMovementObservationSource,
    occurred_at: row.occurred_at as string,
    source_address: row.source_address as string | null,
    transaction_signature: row.transaction_signature as string | null,
    transaction_instruction_index: row.transaction_instruction_index as number | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: row.completed_at as string | null,
  };
}

function mapProgramWithdrawalRow(row: Record<string, unknown>): EarnProgramWithdrawalRow {
  // Loud, not defensive: migration 0057's withdrawal_intent_complete CHECK makes
  // this unreachable, and the withdrawal arm's non-nullable intent fields are what
  // keep resolveIdempotencyReplay's "null fingerprint = unclaimed" branch
  // unrepresentable. If the DB ever hands us one anyway, the schema drifted from
  // the type and a 500 is the correct outcome — silently coercing would hand the
  // replay path a row it must never see.
  if (row.idempotency_fingerprint === null || row.request_id === null) {
    throw new Error(
      `earn movement ${String(row.id)} is a withdrawal with no intent columns; schema drift`
    );
  }
  return {
    ...mapMovementCommon(row),
    direction: "withdrawal",
    project_id: row.project_id as string,
    amount_requested_usd: row.amount_requested_usd as string,
    destination_address: row.destination_address as string,
    request_id: row.request_id as string,
    idempotency_fingerprint: row.idempotency_fingerprint as string,
  };
}

function mapProgramDepositRow(row: Record<string, unknown>): EarnProgramDepositRow {
  return {
    ...mapMovementCommon(row),
    direction: "deposit",
    project_id: null,
    amount_requested_usd: null,
    destination_address: null,
    request_id: null,
    idempotency_fingerprint: null,
  };
}

/** Direction-agnostic read: narrows on the discriminator the DB stores. */
function mapProgramMovementRow(row: Record<string, unknown>): EarnProgramMovementRow {
  return row.direction === "deposit" ? mapProgramDepositRow(row) : mapProgramWithdrawalRow(row);
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
  table: "earn_strategies" | "earn_program_movements" | "earn_provider_wallets",
  conditions: string[],
  bindings: unknown[],
  window: { limit: number; offset: number },
  mapRow: (row: Record<string, unknown>) => Row,
  order: "ASC" | "DESC" = "DESC",
  // The movement ledger sorts on when the MONEY MOVED, not when SDP wrote the
  // row — an observed movement can be recorded long after it happened, and a
  // created_at sort would put an indexer backfill at the head of the list. A
  // closed union, never interpolated from caller input.
  orderColumn: "created_at" | "occurred_at" = "created_at"
): Promise<{ rows: Row[]; total: number }> {
  const where = conditions.join(" AND ");

  const [page, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM ${table}
           WHERE ${where}
           ORDER BY ${orderColumn} ${order}, id ${order}
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
      // Dev-seed fixtures are outside every provider's key space (providers list
      // bare ids, fixtures carry the prefix), so "the provider did not list it"
      // says nothing about them — the seed relies on exactly that to keep its
      // deliberately-paused fixture paused, and prunes its own stale rows.
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
              AND provider_reference NOT LIKE ?
              AND NOT (provider_reference = ANY(?))
            RETURNING provider_reference`
        )
        .bind(input.provider, input.environment, `${EARN_SEED_REFERENCE_PREFIX}%`, [
          ...input.listedProviderReferences,
        ])
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
      //
      // direction/observed_via/occurred_at are literals rather than binds: this is
      // the ONLY intent path, so it is the only writer that may claim
      // 'sdp_intent'. occurred_at is stamped inline by the DB because for an
      // initiated movement the intent IS the moment the movement began — the
      // column has no DEFAULT precisely so an observed writer cannot get "now" by
      // forgetting to supply the movement's real time (migration 0057).
      const row = await db
        .prepare(
          `INSERT INTO earn_program_movements (
             id, organization_id, project_id, wallet_id, provider,
             direction, observed_via, occurred_at,
             amount_requested_usd, token, destination_address,
             request_id, idempotency_fingerprint, provider_data,
             created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, 'withdrawal', 'sdp_intent', sdp_iso_now(),
                     ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
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
      // request_id is null for every observed movement (0057's CHECK), so this
      // query cannot return a deposit — which is what lets the replay path keep a
      // row type whose fingerprint is non-nullable. The direction predicate is
      // belt to that braces, and it also keeps the partial intent index usable.
      const row = await db
        .prepare(
          `SELECT * FROM earn_program_movements
             WHERE organization_id = ? AND wallet_id = ? AND request_id = ?
               AND direction = 'withdrawal'`
        )
        .bind(params.organizationId, params.walletId, params.requestId)
        .first<Record<string, unknown>>();
      return row ? mapProgramWithdrawalRow(row) : null;
    },

    async getProgramWithdrawalByProviderReference(params) {
      // direction is part of the unique index now (0057): a provider that reuses
      // one id space across deposits and withdrawals would otherwise resolve the
      // wrong movement here and let an observation advance it.
      const row = await db
        .prepare(
          `SELECT * FROM earn_program_movements
             WHERE provider = ? AND direction = 'withdrawal' AND provider_reference = ?`
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
      if (input.observedVia !== undefined) {
        assignments.push("observed_via = ?");
        assignmentValues.push(input.observedVia);
      }
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

      // The CAS guard, the org scope and the direction pin live in the same WHERE
      // as the selector, so the whole transition is one atomic statement: the
      // loser of a concurrent race simply matches zero rows. `direction` is what
      // stops a withdrawal observation from ever advancing a deposit row.
      const conditions = ["organization_id = ?", "direction = 'withdrawal'", "status = ANY(?)"];
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
          `UPDATE earn_program_movements
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
      // Wallet-scoped, not (org, project): every project in the environment
      // reaches the same programs, and since PRO-1670 an organization may hold
      // several — so the wallet id is what both joins sibling projects' history
      // and keeps a sibling PROGRAM's payouts out. One program = one history.
      //
      // Ordered on occurred_at rather than created_at: for an initiated movement
      // the two are the same instant, so the page order is unchanged from 0055 —
      // but occurred_at is the column 0057 indexes, and it is what keeps this list
      // consistent with the cross-direction one.
      const conditions = ["organization_id = ?", "wallet_id = ?", "direction = 'withdrawal'"];
      const bindings: unknown[] = [input.organizationId, input.walletId];

      return selectPage(
        db,
        "earn_program_movements",
        conditions,
        bindings,
        input,
        mapProgramWithdrawalRow,
        "DESC",
        "occurred_at"
      );
    },

    async insertProgramDeposit(input: InsertEarnProgramDepositInput) {
      const id = generateEarnProgramDepositId();

      // No ON CONFLICT: a conflict here means "another observer already recorded
      // this movement", which the applier answers by re-reading and advancing the
      // existing row (services/earn-deposit-ledger.service.ts). Swallowing it with
      // DO NOTHING would hide the case where the two observations DISAGREE, and
      // DO UPDATE would let a stale re-observation overwrite a settled row without
      // passing the status guard. The unique violation is the signal.
      //
      // The amount lands in amount_paid_usd — the money that actually moved.
      // Nobody requested a deposit, so amount_requested_usd stays NULL (0057).
      const row = await db
        .prepare(
          `INSERT INTO earn_program_movements (
             id, organization_id, wallet_id, provider,
             direction, status, observed_via, occurred_at,
             amount_paid_usd, token,
             provider_reference, source_address,
             transaction_signature, transaction_instruction_index,
             completed_at, provider_data
           ) VALUES (?, ?, ?, ?, 'deposit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.walletId,
          input.provider,
          input.status,
          input.observedVia,
          input.occurredAt,
          input.amountUsd,
          input.token,
          input.providerReference,
          input.sourceAddress,
          input.transactionSignature,
          input.transactionInstructionIndex,
          input.completedAt,
          JSON.stringify(input.providerData ?? {})
        )
        .first<Record<string, unknown>>();

      return row ? mapProgramDepositRow(row) : null;
    },

    async getProgramDepositByProviderReference(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_program_movements
             WHERE provider = ? AND direction = 'deposit' AND provider_reference = ?`
        )
        .bind(params.provider, params.providerReference)
        .first<Record<string, unknown>>();
      return row ? mapProgramDepositRow(row) : null;
    },

    async listProgramDepositsBySignature(params) {
      // Returns a LIST, not a row, and that is the honest shape: one transaction
      // may legally carry several transfers to one funding address, so the
      // signature index cannot be unique (0057) and a probe can be ambiguous. The
      // caller decides — and must skip rather than guess.
      const page = await db
        .prepare(
          `SELECT * FROM earn_program_movements
             WHERE wallet_id = ? AND direction = 'deposit' AND transaction_signature = ?
             ORDER BY occurred_at ASC, id ASC`
        )
        .bind(params.walletId, params.transactionSignature)
        .all<Record<string, unknown>>();
      return (page.results ?? []).map(mapProgramDepositRow);
    },

    async updateProgramDepositStatusGuarded(input: UpdateEarnProgramDepositStatusGuardedInput) {
      // Same contract as the withdrawal CAS: `undefined` untouched, `null`
      // written, provider_data shallow-merged, updated_at DB-stamped. occurred_at
      // is absent by design — it is write-once (0057).
      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const assignmentValues: unknown[] = [input.toStatus];
      if (input.amountUsd !== undefined) {
        assignments.push("amount_paid_usd = ?");
        assignmentValues.push(input.amountUsd);
      }
      if (input.providerReference !== undefined) {
        assignments.push("provider_reference = ?");
        assignmentValues.push(input.providerReference);
      }
      if (input.sourceAddress !== undefined) {
        assignments.push("source_address = ?");
        assignmentValues.push(input.sourceAddress);
      }
      if (input.transactionSignature !== undefined) {
        assignments.push("transaction_signature = ?");
        assignmentValues.push(input.transactionSignature);
      }
      if (input.transactionInstructionIndex !== undefined) {
        assignments.push("transaction_instruction_index = ?");
        assignmentValues.push(input.transactionInstructionIndex);
      }
      if (input.observedVia !== undefined) {
        assignments.push("observed_via = ?");
        assignmentValues.push(input.observedVia);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        assignmentValues.push(input.completedAt);
      }
      if (input.providerData !== undefined) {
        assignments.push("provider_data = provider_data || ?::jsonb");
        assignmentValues.push(JSON.stringify(input.providerData));
      }

      const conditions = ["organization_id = ?", "direction = 'deposit'", "status = ANY(?)"];
      const conditionValues: unknown[] = [input.organizationId, [...input.fromStatuses]];
      if ("depositId" in input.selector) {
        conditions.push("id = ?");
        conditionValues.push(input.selector.depositId);
      } else if ("providerReference" in input.selector) {
        conditions.push("provider = ?", "provider_reference = ?");
        conditionValues.push(input.selector.provider, input.selector.providerReference);
      } else {
        // Chain selector. The instruction index may legitimately be null (a
        // provider-observed row the indexer is adopting), and `IS NOT DISTINCT
        // FROM` is what makes null match null — `= NULL` never would, so the
        // adoption write would silently match zero rows.
        conditions.push(
          "wallet_id = ?",
          "transaction_signature = ?",
          "transaction_instruction_index IS NOT DISTINCT FROM ?"
        );
        conditionValues.push(
          input.selector.walletId,
          input.selector.transactionSignature,
          input.selector.transactionInstructionIndex
        );
      }

      const row = await db
        .prepare(
          `UPDATE earn_program_movements
             SET ${assignments.join(", ")}
           WHERE ${conditions.join(" AND ")}
           RETURNING *`
        )
        .bind(...assignmentValues, ...conditionValues)
        .first<Record<string, unknown>>();

      return row ? mapProgramDepositRow(row) : null;
    },

    async listProgramMovements(
      input: ListEarnProgramMovementsInput
    ): Promise<ListEarnProgramMovementsResult> {
      const conditions = ["organization_id = ?", "wallet_id = ?"];
      const bindings: unknown[] = [input.organizationId, input.walletId];

      // "all" is spelled out by the caller, never defaulted — see the input type.
      if (input.direction !== "all") {
        conditions.push("direction = ?");
        bindings.push(input.direction);
      }
      if (input.statuses !== undefined && input.statuses.length > 0) {
        conditions.push("status = ANY(?)");
        bindings.push([...input.statuses]);
      }
      if (input.token !== undefined) {
        conditions.push("token = ?");
        bindings.push(input.token);
      }
      // Half-open [from, to): a closed upper bound double-counts a movement that
      // lands exactly on a period boundary.
      //
      // Both bounds are normalized to the column's fixed-width shape first — see
      // toMovementTimestamp. occurred_at is TEXT compared lexicographically, so an
      // otherwise-legal bound like "2026-09-01T00:00:00Z" would put the boundary
      // movement in the WRONG period rather than merely near the edge.
      if (input.occurredFrom !== undefined) {
        conditions.push("occurred_at >= ?");
        bindings.push(toMovementTimestamp(input.occurredFrom) ?? input.occurredFrom);
      }
      if (input.occurredTo !== undefined) {
        conditions.push("occurred_at < ?");
        bindings.push(toMovementTimestamp(input.occurredTo) ?? input.occurredTo);
      }

      return selectPage(
        db,
        "earn_program_movements",
        conditions,
        bindings,
        input,
        mapProgramMovementRow,
        "DESC",
        "occurred_at"
      );
    },

    async sumProgramMovementsByDirection(input: SumEarnProgramMovementsInput) {
      // Settled money only by default: failed and cancelled movements moved
      // nothing, and requested/processing have not moved yet.
      const statuses = input.statuses ?? DEFAULT_SETTLED_MOVEMENT_STATUSES;

      // COALESCE(paid, requested) is the money that actually moved for either
      // direction: a deposit only ever has the paid figure, and a withdrawal's
      // paid figure is authoritative once the provider settles.
      //
      // ::numeric inside the aggregate is a READ-time cast and does not weaken the
      // "money is TEXT decimal strings" storage rule — it preserves exact provider
      // strings on disk while summing them exactly here, and it throws loudly on
      // malformed text, which is the correct outcome when the only writers are our
      // own mappers.
      const page = await db
        .prepare(
          // The SETTLED WALLET-FLOW definition, and the only one any period
          // accounting may use:
          //   * `total_usd` sums amount_paid_usd ALONE — what the provider says
          //     actually moved. It never falls back to the requested figure,
          //     because for a partially_completed row the request is precisely the
          //     amount that did NOT move.
          //   * `total_fee_usd` is summed SEPARATELY and is real wallet outflow: a
          //     withdrawal reduces the wallet by paid + fee, so omitting fees
          //     misclassifies every one of them as negative earnings in
          //     "delta balance - net movements = earnings". Deposits carry no fee.
          //   * a settled row whose paid amount is missing is UNKNOWN, not zero and
          //     not the request. Those rows are excluded from both sums and counted
          //     in `unknown_amount_count`, so a caller can see that a period is
          //     incomplete instead of silently reporting a wrong total.
          `SELECT direction,
                  token,
                  COUNT(*)::int AS movement_count,
                  COUNT(*) FILTER (WHERE amount_paid_usd IS NULL)::int
                    AS unknown_amount_count,
                  COALESCE(
                    SUM(amount_paid_usd::numeric) FILTER (WHERE amount_paid_usd IS NOT NULL),
                    0
                  )::text AS total_usd,
                  COALESCE(
                    SUM(COALESCE(fee_usd, '0')::numeric) FILTER (WHERE amount_paid_usd IS NOT NULL),
                    0
                  )::text AS total_fee_usd
             FROM earn_program_movements
            WHERE organization_id = ?
              AND wallet_id = ?
              AND occurred_at >= ?
              AND occurred_at < ?
              AND status = ANY(?)
            GROUP BY direction, token
            ORDER BY direction ASC, token ASC`
        )
        .bind(
          input.organizationId,
          input.walletId,
          // Same normalization as the list read: an internal caller (PRO-1672's
          // period statements) never passes through the route schema, so the guard
          // has to live here rather than only at the edge.
          toMovementTimestamp(input.occurredFrom) ?? input.occurredFrom,
          toMovementTimestamp(input.occurredTo) ?? input.occurredTo,
          [...statuses]
        )
        .all<Record<string, unknown>>();

      return (page.results ?? []).map((row) => ({
        direction: row.direction as EarnMovementDirection,
        token: row.token as EarnPortfolioToken,
        movementCount: row.movement_count as number,
        unknownAmountCount: row.unknown_amount_count as number,
        totalUsd: row.total_usd as string,
        totalFeeUsd: row.total_fee_usd as string,
      }));
    },

    async scanProviderWallets(input: ScanEarnProviderWalletsInput) {
      // Keyset, not OFFSET: migration 0056 fixed (created_at, id) ASC as stable for
      // a program's life, so this cannot skip a program because a sibling was
      // created mid-pass. created_at is fixed-width ISO from sdp_iso_now(), so
      // lexicographic comparison is chronological. Spelled-out disjunction rather
      // than a row-value comparison, matching the private-channel keyset reads.
      const conditions = ["environment = ?"];
      const bindings: unknown[] = [input.environment];
      if (input.after !== undefined) {
        conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
        bindings.push(input.after.createdAt, input.after.createdAt, input.after.id);
      }

      const page = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE ${conditions.join(" AND ")}
             ORDER BY created_at ASC, id ASC
             LIMIT ?`
        )
        .bind(...bindings, input.limit)
        .all<Record<string, unknown>>();

      return (page.results ?? []).map(mapProviderWalletRow);
    },
  };
}
