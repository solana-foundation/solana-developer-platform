import type { AppDb } from "@/db";
import {
  DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT,
  DEFAULT_RINGS_OPERATION_LIST_LIMIT,
  type FailHeliusRingsOperationInput,
  generateHeliusRingsOperationId,
  type HeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
  type HeliusRingsTimelockRow,
  type ListHeliusRingsInFlightOperationsInput,
  type ListHeliusRingsOperationsByProjectInput,
  type ListHeliusRingsOperationsByWalletInput,
  type ReleaseHeliusRingsTimelockInput,
  type ReserveHeliusRingsIntentInput,
  type TransitionHeliusRingsOperationInput,
} from "./helius-rings-operation.repository";
import type { HeliusRingsProjectScope } from "./helius-rings-wallet.repository";

/** The states the resume sweep considers live, matching the partial index. */
const IN_FLIGHT_STATES = [
  "preparing",
  "approval_required",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
] as const;

function mapRow(row: Record<string, unknown>): HeliusRingsOperationRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    wallet_id: row.wallet_id as string,
    op_type: row.op_type as HeliusRingsOperationRow["op_type"],
    state: row.state as HeliusRingsOperationRow["state"],
    asset_mint: (row.asset_mint ?? null) as string | null,
    amount_raw: (row.amount_raw ?? null) as string | null,
    from_addr: (row.from_addr ?? null) as string | null,
    to_addr: (row.to_addr ?? null) as string | null,
    zone_id: (row.zone_id ?? null) as string | null,
    transfer_mode: (row.transfer_mode ?? null) as HeliusRingsOperationRow["transfer_mode"],
    intent_key: row.intent_key as string,
    approval_request_id: (row.approval_request_id ?? null) as string | null,
    policy_evaluation_id: (row.policy_evaluation_id ?? null) as string | null,
    proof_source: (row.proof_source ?? null) as HeliusRingsOperationRow["proof_source"],
    proof_ref: (row.proof_ref ?? null) as string | null,
    outer_tx_signature: (row.outer_tx_signature ?? null) as string | null,
    photon_indexed_at: (row.photon_indexed_at ?? null) as string | null,
    failure_code: (row.failure_code ?? null) as HeliusRingsOperationRow["failure_code"],
    failure_message: (row.failure_message ?? null) as string | null,
    retryable: (row.retryable ?? null) as boolean | null,
    retry_of_operation_id: (row.retry_of_operation_id ?? null) as string | null,
    timelock_unlock_at: (row.timelock_unlock_at ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapTimelockRow(row: Record<string, unknown>): HeliusRingsTimelockRow {
  return {
    operation_id: row.operation_id as string,
    unlock_at: row.unlock_at as string,
    released_at: (row.released_at ?? null) as string | null,
    beneficiary_addr: row.beneficiary_addr as string,
  };
}

export function createPostgresHeliusRingsOperationRepository(
  db: AppDb
): HeliusRingsOperationRepository {
  return {
    async reserveIntent(input: ReserveHeliusRingsIntentInput) {
      const id = generateHeliusRingsOperationId();

      return db.transaction(async (tx) => {
        const row = await tx
          .prepare(
            `INSERT INTO helius_rings_operations (
               id,
               organization_id,
               project_id,
               wallet_id,
               op_type,
               intent_key,
               asset_mint,
               amount_raw,
               from_addr,
               to_addr,
               zone_id,
               transfer_mode,
               retry_of_operation_id,
               timelock_unlock_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (intent_key)
             -- Self-assignment rather than DO NOTHING: DO NOTHING returns zero
             -- rows on a replay, which is indistinguishable from a failed
             -- insert. Assigning updated_at to itself makes RETURNING emit the
             -- row that is already there without altering it.
             DO UPDATE SET updated_at = helius_rings_operations.updated_at
             RETURNING *`
          )
          .bind(
            id,
            input.organizationId,
            input.projectId,
            input.walletId,
            input.opType,
            input.intentKey,
            input.assetMint ?? null,
            input.amountRaw ?? null,
            input.fromAddr ?? null,
            input.toAddr ?? null,
            input.zoneId ?? null,
            input.transferMode ?? null,
            input.retryOfOperationId ?? null,
            input.timelock?.unlockAt ?? null
          )
          .first<Record<string, unknown>>();

        if (!row) {
          // The upsert always returns a row; a null here means the statement
          // matched nothing at all, which is not a state this table can reach.
          throw new Error("helius rings reserveIntent returned no row");
        }

        const operation = mapRow(row);
        // The id we generated only survives if this call is the one that
        // inserted. On a replay the row carries the original id, which is a
        // cheaper and clearer signal than inspecting xmax.
        const reserved = operation.id === id;

        if (reserved && input.timelock) {
          await tx
            .prepare(
              `INSERT INTO helius_rings_timelocks (operation_id, unlock_at, beneficiary_addr)
               VALUES (?, ?, ?)
               ON CONFLICT (operation_id) DO NOTHING`
            )
            .bind(operation.id, input.timelock.unlockAt, input.timelock.beneficiaryAddr)
            .run();
        }

        return { operation, reserved };
      });
    },

    async getOperationById(input: HeliusRingsProjectScope & { id: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getOperationByIntentKey(input: HeliusRingsProjectScope & { intentKey: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE intent_key = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(input.intentKey, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listOperationsByWallet(input: ListHeliusRingsOperationsByWalletInput) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE wallet_id = ? AND organization_id = ? AND project_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(
          input.walletId,
          input.organizationId,
          input.projectId,
          input.limit ?? DEFAULT_RINGS_OPERATION_LIST_LIMIT
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listOperationsByProject(input: ListHeliusRingsOperationsByProjectInput) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE organization_id = ? AND project_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.limit ?? DEFAULT_RINGS_OPERATION_LIST_LIMIT
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async transitionState(input: TransitionHeliusRingsOperationInput) {
      return db.transaction(async (tx) => {
        // Lock first. Two workers resuming the same operation would otherwise
        // both read `submitted`, both write `indexing`, and both go on to do the
        // follow-up work once each.
        const locked = await tx
          .prepare(
            `SELECT state FROM helius_rings_operations
              WHERE id = ? AND organization_id = ? AND project_id = ?
              FOR UPDATE`
          )
          .bind(input.id, input.organizationId, input.projectId)
          .first<{ state: string }>();

        if (!locked || locked.state !== input.expectedState) return null;

        const patch = input.patch ?? {};
        const assignments: string[] = ["state = ?", "updated_at = sdp_iso_now()"];
        const values: unknown[] = [input.nextState];

        // Only columns the caller named are written, so a later step cannot
        // blank the approval id an earlier one recorded.
        if (patch.approvalRequestId !== undefined) {
          assignments.push("approval_request_id = ?");
          values.push(patch.approvalRequestId);
        }
        if (patch.policyEvaluationId !== undefined) {
          assignments.push("policy_evaluation_id = ?");
          values.push(patch.policyEvaluationId);
        }
        if (patch.proofSource !== undefined) {
          assignments.push("proof_source = ?");
          values.push(patch.proofSource);
        }
        if (patch.proofRef !== undefined) {
          assignments.push("proof_ref = ?");
          values.push(patch.proofRef);
        }
        if (patch.outerTxSignature !== undefined) {
          assignments.push("outer_tx_signature = ?");
          values.push(patch.outerTxSignature);
        }
        if (patch.photonIndexedAt !== undefined) {
          assignments.push("photon_indexed_at = ?");
          values.push(patch.photonIndexedAt);
        }

        const row = await tx
          .prepare(
            `UPDATE helius_rings_operations
                SET ${assignments.join(", ")}
              WHERE id = ? AND organization_id = ? AND project_id = ?
            RETURNING *`
          )
          .bind(...values, input.id, input.organizationId, input.projectId)
          .first<Record<string, unknown>>();

        return row ? mapRow(row) : null;
      });
    },

    async failOperation(input: FailHeliusRingsOperationInput) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .prepare(
            `SELECT state FROM helius_rings_operations
              WHERE id = ? AND organization_id = ? AND project_id = ?
              FOR UPDATE`
          )
          .bind(input.id, input.organizationId, input.projectId)
          .first<{ state: string }>();

        if (!locked || locked.state !== input.expectedState) return null;

        // The failure triple moves together because the DB CHECK requires it:
        // a `failed` row without a code is unactionable in the recovery UI.
        const row = await tx
          .prepare(
            `UPDATE helius_rings_operations
                SET state = 'failed',
                    failure_code = ?,
                    failure_message = ?,
                    retryable = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ? AND project_id = ?
            RETURNING *`
          )
          .bind(
            input.code,
            input.message,
            input.retryable,
            input.id,
            input.organizationId,
            input.projectId
          )
          .first<Record<string, unknown>>();

        return row ? mapRow(row) : null;
      });
    },

    async listInFlightOperations(input: ListHeliusRingsInFlightOperationsInput) {
      const placeholders = IN_FLIGHT_STATES.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE state IN (${placeholders})
              AND updated_at < ?
            ORDER BY updated_at ASC, id ASC
            LIMIT ?`
        )
        .bind(
          ...IN_FLIGHT_STATES,
          input.staleBefore,
          input.limit ?? DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async getTimelock(input: { operationId: string }) {
      const row = await db
        .prepare(`SELECT * FROM helius_rings_timelocks WHERE operation_id = ?`)
        .bind(input.operationId)
        .first<Record<string, unknown>>();
      return row ? mapTimelockRow(row) : null;
    },

    async listReleasableTimelocks(input: { asOf: string; limit?: number }) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_timelocks
            WHERE released_at IS NULL AND unlock_at <= ?
            ORDER BY unlock_at ASC, operation_id ASC
            LIMIT ?`
        )
        .bind(input.asOf, input.limit ?? DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT)
        .all<Record<string, unknown>>();
      return result.results.map(mapTimelockRow);
    },

    async releaseTimelock(input: ReleaseHeliusRingsTimelockInput) {
      // `released_at IS NULL` is the whole guard: it makes the release
      // single-shot, so two sweeps racing produce one payout and one null.
      const row = await db
        .prepare(
          `UPDATE helius_rings_timelocks
              SET released_at = ?
            WHERE operation_id = ? AND released_at IS NULL
          RETURNING *`
        )
        .bind(input.releasedAt, input.operationId)
        .first<Record<string, unknown>>();
      return row ? mapTimelockRow(row) : null;
    },
  };
}
