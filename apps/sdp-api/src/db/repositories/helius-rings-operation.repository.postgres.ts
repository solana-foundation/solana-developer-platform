import type { AppDb } from "@/db";
import {
  DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT,
  DEFAULT_RINGS_OPERATION_LIST_LIMIT,
  type FailHeliusRingsOperationInput,
  generateHeliusRingsOperationId,
  type HeliusRingsExpiredSubmissionsInput,
  type HeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
  type HeliusRingsTimelockRow,
  type ListHeliusRingsInFlightOperationsInput,
  type ListHeliusRingsOperationsByProjectInput,
  type ListHeliusRingsOperationsByWalletInput,
  type PersistHeliusRingsSignedInput,
  type ReleaseHeliusRingsTimelockInput,
  type ReserveHeliusRingsIntentInput,
  type TransitionHeliusRingsOperationInput,
} from "./helius-rings-operation.repository";
import type { HeliusRingsProjectScope } from "./helius-rings-wallet.repository";

/**
 * The states the resume sweep can actually move forward, a subset of the
 * partial index's predicate so it still reads from that index.
 *
 * `preparing` and `approval_required` are excluded even though the index covers
 * them: neither holds a wallet's spend slot or blocks a later operation, and an
 * approval waits on a person indefinitely. Returning them would let a backlog of
 * rows nothing can advance fill the sweep's row budget, oldest first, and starve
 * the ones it exists to settle.
 */
const IN_FLIGHT_STATES = ["proving", "ready_to_sign", "submitted", "indexing"] as const;

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
    ring_program_id: (row.ring_program_id ?? null) as string | null,
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
    input_notes: mapInputNotes(row.input_notes),
    signed_transaction: (row.signed_transaction ?? null) as string | null,
    // NUMERIC comes back as a string from pg, which is what we want: this is a
    // uint64 and Number would start losing precision partway up the range.
    last_valid_block_height:
      row.last_valid_block_height === null || row.last_valid_block_height === undefined
        ? null
        : String(row.last_valid_block_height),
    submission_started_at: (row.submission_started_at ?? null) as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * jsonb arrives parsed, so this is a shape check rather than a decode. A row
 * whose notes are not an array of strings cannot be rebuilt against, and
 * silently treating it as absent would let the rebuild reselect freely — the
 * exact thing pinning them prevents.
 */
function mapInputNotes(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("helius_rings_operations.input_notes is not an array of strings");
  }
  return value as string[];
}

/**
 * The SET clause for a transition, covering only the columns the caller named.
 *
 * Only-what-was-named is the contract: a later step in the pipeline must not
 * blank the approval id or the note set an earlier one recorded, and a patch
 * type where every field is optional is how that is expressed.
 */
function transitionAssignments(input: TransitionHeliusRingsOperationInput): {
  assignments: string[];
  values: unknown[];
} {
  const patch = input.patch ?? {};
  const assignments = ["state = ?", "updated_at = sdp_iso_now()"];
  const values: unknown[] = [input.nextState];

  const columns: ReadonlyArray<readonly [string, unknown]> = [
    ["approval_request_id", patch.approvalRequestId],
    ["policy_evaluation_id", patch.policyEvaluationId],
    ["proof_source", patch.proofSource],
    ["proof_ref", patch.proofRef],
    ["outer_tx_signature", patch.outerTxSignature],
    ["photon_indexed_at", patch.photonIndexedAt],
  ];

  for (const [column, value] of columns) {
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }

  // Separate because it is the one jsonb column, and it is written as text with
  // an explicit cast rather than relying on the driver to guess the type.
  if (patch.inputNotes !== undefined) {
    assignments.push("input_notes = ?::jsonb");
    values.push(patch.inputNotes === null ? null : JSON.stringify(patch.inputNotes));
  }

  return { assignments, values };
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
               ring_program_id,
               retry_of_operation_id,
               timelock_unlock_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            input.ringProgramId ?? null,
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
      if (input.walletIds?.length === 0) return [];

      const bindings: unknown[] = [input.organizationId, input.projectId];
      const walletScope = input.walletIds ? " AND wallet_id = ANY(?)" : "";
      if (input.walletIds) bindings.push([...input.walletIds]);
      bindings.push(input.limit ?? DEFAULT_RINGS_OPERATION_LIST_LIMIT);

      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE organization_id = ? AND project_id = ?${walletScope}
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(...bindings)
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

        const { assignments, values } = transitionAssignments(input);

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

    async persistSigned(input: PersistHeliusRingsSignedInput) {
      // The NULL guards are the idempotency contract, not defensive coding: a
      // second signing of the same operation produces different bytes for the
      // same intent, and both sets could land. Losing this update is how a
      // concurrent worker is told the bytes are already chosen.
      const row = await db
        .prepare(
          `UPDATE helius_rings_operations
              SET outer_tx_signature = ?,
                  signed_transaction = ?,
                  last_valid_block_height = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND state = 'ready_to_sign'
              AND outer_tx_signature IS NULL
              AND signed_transaction IS NULL
              AND last_valid_block_height IS NULL
              AND submission_started_at IS NULL
          RETURNING *`
        )
        .bind(
          input.signature,
          input.signedTransaction,
          input.lastValidBlockHeight,
          input.id,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async markSubmissionStarted(input: HeliusRingsProjectScope & { id: string; at: string }) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_operations
              SET submission_started_at = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND signed_transaction IS NOT NULL
              AND submission_started_at IS NULL
          RETURNING *`
        )
        .bind(input.at, input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listExpiredSubmissions(input: HeliusRingsExpiredSubmissionsInput) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE signed_transaction IS NOT NULL
              AND last_valid_block_height < ?
              AND state IN ('submitted', 'indexing')
            ORDER BY last_valid_block_height ASC
            LIMIT ?`
        )
        .bind(input.blockHeight, input.limit ?? DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async findBlockingOperation(
      input: HeliusRingsProjectScope & { walletId: string; opTypes: readonly string[] }
    ) {
      // The same predicate the two unique indexes carry, deliberately in step
      // with them: this exists to give the caller a real message before the
      // index gives them a constraint name.
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE wallet_id = ?
              AND organization_id = ?
              AND project_id = ?
              AND op_type = ANY(?)
              AND (
                    state IN ('proving', 'ready_to_sign', 'submitted', 'indexing')
                 OR (state = 'failed' AND signed_transaction IS NOT NULL)
              )
            ORDER BY created_at ASC
            LIMIT 1`
        )
        .bind(input.walletId, input.organizationId, input.projectId, [...input.opTypes])
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async completeFromFailed(
      input: HeliusRingsProjectScope & { id: string; photonIndexedAt: string }
    ) {
      // Compare-and-swap on `failed`: losing it means another worker or a
      // concurrent reconcile already moved the row, which is not an error.
      const row = await db
        .prepare(
          `UPDATE helius_rings_operations
              SET state = 'completed',
                  failure_code = NULL,
                  failure_message = NULL,
                  retryable = NULL,
                  photon_indexed_at = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND state = 'failed'
          RETURNING *`
        )
        .bind(input.photonIndexedAt, input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async voidOperation(input: HeliusRingsProjectScope & { id: string }) {
      // Only from a signed failure. An unsigned one has nothing on chain to
      // reconcile and belongs to retry instead.
      const row = await db
        .prepare(
          `UPDATE helius_rings_operations
              SET state = 'voided',
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND state = 'failed'
              AND signed_transaction IS NOT NULL
          RETURNING *`
        )
        .bind(input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listSignedFailures(input: { limit?: number }) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE state = 'failed'
              AND signed_transaction IS NOT NULL
            ORDER BY updated_at ASC
            LIMIT ?`
        )
        .bind(input.limit ?? DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listExpiredSignedFailures(input: HeliusRingsExpiredSubmissionsInput) {
      // Same shape as listExpiredSubmissions, but for rows that already failed
      // with signed bytes and a resolvable code — the ones the reconcile pass
      // needs to upgrade so an operator can void the wallet's blocked slot.
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_operations
            WHERE state = 'failed'
              AND signed_transaction IS NOT NULL
              AND failure_code IS NOT NULL
              AND failure_code <> 'manual_reconciliation_required'
              AND last_valid_block_height IS NOT NULL
              AND last_valid_block_height < ?
            ORDER BY last_valid_block_height ASC
            LIMIT ?`
        )
        .bind(input.blockHeight, input.limit ?? DEFAULT_RINGS_IN_FLIGHT_SWEEP_LIMIT)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async escalateToManualReconciliation(input: HeliusRingsProjectScope & { id: string }) {
      // failure_message deliberately untouched: the original names the actual
      // reason (rpc error, preflight rejection); overwriting it with a generic
      // "blockhash expired" would lose the only diagnostic the row carries.
      const row = await db
        .prepare(
          `UPDATE helius_rings_operations
              SET failure_code = 'manual_reconciliation_required',
                  retryable = false,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND state = 'failed'
              AND signed_transaction IS NOT NULL
              AND failure_code IS NOT NULL
              AND failure_code <> 'manual_reconciliation_required'
          RETURNING *`
        )
        .bind(input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async failOperation(input: FailHeliusRingsOperationInput) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .prepare(
            `SELECT state, signed_transaction FROM helius_rings_operations
              WHERE id = ? AND organization_id = ? AND project_id = ?
              FOR UPDATE`
          )
          .bind(input.id, input.organizationId, input.projectId)
          .first<{ state: string; signed_transaction: string | null }>();

        if (!locked || locked.state !== input.expectedState) return null;
        // `ready_to_sign` is the only failure edge that can race a signer
        // holding bytes in memory. The row lock arbitrates with persistSigned:
        // if persistence committed first, recovery must leave the row resumable;
        // if this failure commits first, persistSigned's state guard loses.
        if (input.expectedState === "ready_to_sign" && locked.signed_transaction !== null) {
          return null;
        }

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
