import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { OperationReference } from "@sdp/types/operations";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";
import type { EarnWalletWithdrawalRequestTransactionRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { conflict, internalError, notFound } from "@/lib/errors";

/** Current-request release has no historical redemption or economic payout claim. */
export function isCurrentRedemptionReleaseBuild(
  build: Pick<
    EarnWalletWithdrawalRequestTransactionRow,
    "action" | "mechanism" | "withdrawal_request_id" | "operation_only"
  >
): boolean {
  return (
    build.action === "cancel" &&
    build.mechanism === "operator_redemption" &&
    build.withdrawal_request_id === null &&
    build.operation_only === true
  );
}

/** Exact accepted operation attempt that owns this standalone release build. */
export interface CurrentRedemptionReleaseInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  transactionId: string;
  attemptId: string;
}

/** Shared aliases are fixed so every address and reconciliation guard uses one identity. */
export const CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL = `
  request.mechanism = 'operator_redemption' AND release.environment = request.environment AND release.request_address = request.request_address
  AND release.organization_id = request.organization_id AND release.project_id = request.project_id
  AND (request.position_id IS NULL OR release.position_id = request.position_id)
  AND release.provider = request.provider
  AND release.owner_address = request.owner_address
  AND release.custody_wallet_id IS NOT DISTINCT FROM request.custody_wallet_id
  AND release.vault_address = request.vault_address
  AND release.token_mint = request.token_mint AND release.share_mint = request.share_mint
  AND release.action = 'cancel' AND release.mechanism = 'operator_redemption'
  AND release.withdrawal_request_id IS NULL AND release.operation_only
  AND release.consumed_attempt_id IS NOT NULL AND release.consumed_at >= request.created_at`;

/** Scope for freezing a historical request without assigning it a later cycle's outcome. */
export interface CurrentRedemptionRequestFenceInput {
  organizationId: string;
  environment: SdpEnvironment;
  withdrawalRequestId: string;
}

type FencedSourceTable =
  | "earn_vault_withdrawal_requests"
  | "earn_wallet_withdrawal_request_transactions";

async function isSourceFencedByCurrentRedemptionRelease(
  tx: DatabaseExecutor,
  table: FencedSourceTable,
  input: { id: string; organizationId: string; environment: SdpEnvironment }
): Promise<boolean> {
  const row = await tx.queryOne<{ fenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${table} request
       JOIN earn_wallet_withdrawal_request_transactions release
         ON ${CURRENT_REDEMPTION_RELEASE_COVERS_REQUEST_SQL}
       JOIN operation_attempts attempt ON attempt.id = release.consumed_attempt_id
         AND attempt.organization_id = release.organization_id
         AND attempt.project_id = release.project_id AND attempt.environment = release.environment
       JOIN operations operation ON operation.id = attempt.operation_id
         AND operation.organization_id = attempt.organization_id
         AND operation.project_id = attempt.project_id AND operation.environment = attempt.environment
       WHERE request.id = ? AND request.organization_id = ? AND request.environment = ?
         AND (release.release_finalized_at IS NOT NULL
           OR operation.status NOT IN ('completed', 'failed', 'cancelled'))
     ) AS fenced`,
    [input.id, input.organizationId, input.environment]
  );
  if (row === null) throw internalError("Current redemption release fence result is missing");
  return row.fenced;
}

/** Accepted release may affect a replacement cycle; only definitive no-effect failure lifts it. */
export function isRequestFencedByCurrentRedemptionReleaseWithin(
  tx: DatabaseExecutor,
  input: CurrentRedemptionRequestFenceInput
): Promise<boolean> {
  return isSourceFencedByCurrentRedemptionRelease(tx, "earn_vault_withdrawal_requests", {
    ...input,
    id: input.withdrawalRequestId,
  });
}

/** Retained build identity prevents late history adoption from masquerading as a new request. */
export function isQueuedBuildFencedByCurrentRedemptionReleaseWithin(
  tx: DatabaseExecutor,
  input: { transactionId: string; organizationId: string; environment: SdpEnvironment }
): Promise<boolean> {
  return isSourceFencedByCurrentRedemptionRelease(
    tx,
    "earn_wallet_withdrawal_request_transactions",
    {
      ...input,
      id: input.transactionId,
    }
  );
}

/** Releasing a provider request changes no historical financial request row. */
export interface CurrentRedemptionReleaseRepository {
  isRequestFencedByCurrentRedemptionRelease(
    input: CurrentRedemptionRequestFenceInput
  ): Promise<boolean>;
  consumeCurrentRedemptionRelease(
    input: CurrentRedemptionReleaseInput & {
      signedTransaction: string;
      signature: string;
    }
  ): Promise<EarnWalletWithdrawalRequestTransactionRow>;
  recordCurrentRedemptionReleaseFinalized(
    input: CurrentRedemptionReleaseInput
  ): Promise<EarnWalletWithdrawalRequestTransactionRow>;
  /** First finalized miss after expiry; only a later miss can prove the release never ran. */
  recordCurrentRedemptionReleaseAbsent(
    input: CurrentRedemptionReleaseInput
  ): Promise<EarnWalletWithdrawalRequestTransactionRow>;
}

type Scope = Pick<CurrentRedemptionReleaseInput, "organizationId" | "projectId" | "environment">;
type AttemptReference = { id: string; buildRef: OperationReference | null };
type ReleaseBuild = EarnWalletWithdrawalRequestTransactionRow & {
  signed_transaction: string | null;
  signature: string | null;
  execution_requested_at: string | null;
};
const values = (scope: Scope) => [scope.organizationId, scope.projectId, scope.environment];

async function lockBuild(
  tx: DatabaseExecutor,
  scope: Scope,
  attempt: AttemptReference
): Promise<EarnWalletWithdrawalRequestTransactionRow | null> {
  if (attempt.buildRef?.kind !== "earn.queued_transaction") return null;
  const build = await tx.queryOne<EarnWalletWithdrawalRequestTransactionRow>(
    `SELECT * FROM earn_wallet_withdrawal_request_transactions
     WHERE id = ? AND organization_id = ? AND project_id = ? AND environment = ? FOR UPDATE`,
    [attempt.buildRef.id, ...values(scope)]
  );
  return build !== null && isCurrentRedemptionReleaseBuild(build) ? build : null;
}

async function requireAttempt(
  tx: DatabaseExecutor,
  input: CurrentRedemptionReleaseInput
): Promise<ReleaseBuild> {
  const row = await tx.queryOne<ReleaseBuild>(
    `SELECT build.*, attempt.signed_transaction, attempt.signature, attempt.execution_requested_at
     FROM operations operation
     JOIN operation_attempts attempt ON attempt.operation_id = operation.id
       AND attempt.organization_id = operation.organization_id
       AND attempt.project_id = operation.project_id AND attempt.environment = operation.environment
       AND attempt.action_id = operation.action_id AND attempt.action_version = operation.action_version
     JOIN earn_wallet_withdrawal_request_transactions build
       ON build.id = attempt.build_ref ->> 'id'
       AND attempt.build_ref ->> 'kind' = 'earn.queued_transaction'
       AND build.organization_id = operation.organization_id
       AND build.project_id = operation.project_id AND build.environment = operation.environment
     WHERE build.id = ? AND attempt.id = ?
       AND operation.organization_id = ? AND operation.project_id = ? AND operation.environment = ?
       AND operation.kind = 'earn.withdraw' AND operation.action_purpose = 'execute'
       AND operation.intent ->> 'positionId' = build.position_id
       AND operation.intent -> 'amount' ->> 'kind' = 'all'
       AND operation.terms -> 'options' @> '[{"id":"release_current_redemption","mechanism":"release_current_redemption"}]'::jsonb
       AND ((build.custody_wallet_id IS NULL AND operation.source ->> 'ownerAddress' = build.owner_address)
         OR (build.custody_wallet_id IS NOT NULL AND operation.source ->> 'walletId' = build.custody_wallet_id))
     FOR UPDATE OF operation, attempt, build`,
    [input.transactionId, input.attemptId, ...values(input)]
  );
  if (row === null || !isCurrentRedemptionReleaseBuild(row))
    throw notFound("Accepted current redemption release");
  return { ...row, last_valid_block_height: String(row.last_valid_block_height) };
}

/** Acquire the global owner/PDA fence in the same transaction as submit acceptance. */
export async function acceptCurrentRedemptionReleaseWithin(
  tx: DatabaseExecutor,
  scope: Scope,
  attempt: AttemptReference
): Promise<void> {
  const build = await lockBuild(tx, scope, attempt);
  if (build === null) return;
  await requireAttempt(tx, { ...scope, transactionId: build.id, attemptId: attempt.id });
  await tx.queryOne("SELECT pg_advisory_xact_lock(2, hashtext(?))", [
    `${scope.environment}:${build.request_address}`,
  ]);
  const lease = await tx.queryOne(
    `INSERT INTO earn_vault_withdrawal_request_pda_leases
       (environment, request_address, lease_token, occupied, expires_at, last_valid_block_height)
     VALUES (?, ?, ?, TRUE, '9999-12-31T23:59:59.999Z', NULL)
     ON CONFLICT (environment, request_address) DO UPDATE
       SET lease_token = EXCLUDED.lease_token, occupied = TRUE,
           expires_at = EXCLUDED.expires_at, last_valid_block_height = NULL
     WHERE earn_vault_withdrawal_request_pda_leases.lease_token = EXCLUDED.lease_token
       OR (NOT earn_vault_withdrawal_request_pda_leases.occupied
         AND earn_vault_withdrawal_request_pda_leases.last_valid_block_height IS NULL)
       OR (earn_vault_withdrawal_request_pda_leases.occupied AND EXISTS (
         SELECT 1 FROM earn_vault_withdrawal_requests request
         WHERE request.id = earn_vault_withdrawal_request_pda_leases.lease_token
           AND request.organization_id = ? AND request.project_id = ? AND request.environment = ?
           AND request.position_id = ? AND request.owner_address = ?
           AND request.custody_wallet_id IS NOT DISTINCT FROM ?
           AND request.provider = ? AND request.vault_address = ?
           AND request.token_mint = ? AND request.share_mint = ?
           AND request.request_address = EXCLUDED.request_address
           AND request.mechanism = 'operator_redemption'
           AND request.status NOT IN ('fulfilled', 'cancelled', 'failed')))
     RETURNING lease_token`,
    [
      scope.environment,
      build.request_address,
      build.id,
      ...values(scope),
      build.position_id,
      build.owner_address,
      build.custody_wallet_id ?? null,
      build.provider,
      build.vault_address,
      build.token_mint,
      build.share_mint,
    ]
  );
  if (lease === null) throw conflict("Another accepted request owns this redemption address");
  if (build.consumed_attempt_id != null && build.consumed_attempt_id !== attempt.id)
    throw conflict("Redemption release already belongs to another operation attempt");
  await tx.execute(
    `UPDATE earn_wallet_withdrawal_request_transactions
     SET consumed_attempt_id = ?, consumed_at = COALESCE(consumed_at,
       to_char(timezone('UTC', clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         updated_at = sdp_iso_now()
     WHERE id = ? AND organization_id = ? AND project_id = ? AND environment = ?`,
    [attempt.id, build.id, ...values(scope)]
  );
}

/** Safe terminal outcomes restore tracked occupancy or retain the normal PDA cooldown. */
export async function releaseCurrentRedemptionReleaseWithin(
  tx: DatabaseExecutor,
  scope: Scope,
  attempt: AttemptReference
): Promise<void> {
  const build = await lockBuild(tx, scope, attempt);
  if (build === null || build.consumed_attempt_id !== attempt.id) return;
  // Definitive failure restores the prior tracked occupancy. A finalized
  // release starts cooldown without assigning an outcome to that older row.
  await tx.execute(
    `UPDATE earn_vault_withdrawal_request_pda_leases lease
     SET lease_token = COALESCE(request.id, lease.lease_token),
       occupied = request.id IS NOT NULL,
       expires_at = CASE WHEN request.id IS NOT NULL THEN '9999-12-31T23:59:59.999Z'
         ELSE to_char(timezone('UTC', now() + INTERVAL '5 minutes'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
       reuse_not_before = CASE WHEN request.id IS NOT NULL THEN lease.reuse_not_before
         ELSE to_char(timezone('UTC', now() + INTERVAL '5 minutes'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
       last_valid_block_height = NULL
     FROM (SELECT (SELECT id FROM earn_vault_withdrawal_requests
       WHERE organization_id = ? AND project_id = ? AND environment = ?
         AND position_id = ? AND owner_address = ? AND custody_wallet_id IS NOT DISTINCT FROM ?
         AND provider = ? AND vault_address = ? AND token_mint = ? AND share_mint = ?
         AND request_address = ? AND mechanism = 'operator_redemption'
         AND status NOT IN ('fulfilled', 'cancelled', 'failed')
         AND ?::text IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1) AS id) request
     WHERE lease.environment = ? AND lease.request_address = ? AND lease.lease_token = ? AND lease.occupied`,
    [
      ...values(scope),
      build.position_id,
      build.owner_address,
      build.custody_wallet_id ?? null,
      build.provider,
      build.vault_address,
      build.token_mint,
      build.share_mint,
      build.request_address,
      build.release_finalized_at ?? null,
      scope.environment,
      build.request_address,
      build.id,
    ]
  );
}

/** Storage proof is local to one attempt; provider evidence is checked before recording. */
export function createCurrentRedemptionReleaseRepository(
  db: DatabaseClient
): CurrentRedemptionReleaseRepository {
  return {
    isRequestFencedByCurrentRedemptionRelease(input) {
      return isRequestFencedByCurrentRedemptionReleaseWithin(db, input);
    },
    async consumeCurrentRedemptionRelease(input) {
      return db.transaction(async (tx) => {
        const build = await requireAttempt(tx, input);
        if (
          build.consumed_attempt_id !== input.attemptId ||
          build.execution_requested_at === null ||
          build.signed_transaction !== input.signedTransaction ||
          build.signature !== input.signature
        )
          throw conflict("Redemption release does not match its accepted signed attempt");
        const lease = await tx.queryOne(
          `SELECT lease_token FROM earn_vault_withdrawal_request_pda_leases
           WHERE environment = ? AND request_address = ? AND lease_token = ? AND occupied`,
          [input.environment, build.request_address, build.id]
        );
        if (lease === null && build.release_finalized_at == null)
          throw conflict("Accepted redemption release lost its address fence");
        return build;
      });
    },
    async recordCurrentRedemptionReleaseFinalized(input) {
      return db.transaction(async (tx) => {
        const build = await requireAttempt(tx, input);
        if (
          build.consumed_attempt_id !== input.attemptId ||
          build.execution_requested_at === null ||
          build.signed_transaction === null ||
          build.signature === null
        )
          throw conflict("Redemption release has no accepted signed attempt");
        const updated = await tx.queryOne<EarnWalletWithdrawalRequestTransactionRow>(
          `UPDATE earn_wallet_withdrawal_request_transactions
           SET release_finalized_at = COALESCE(release_finalized_at, sdp_iso_now()), updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND environment = ? RETURNING *`,
          [input.transactionId, ...values(input)]
        );
        if (updated === null) throw notFound("Current redemption release");
        return { ...updated, last_valid_block_height: String(updated.last_valid_block_height) };
      });
    },
    async recordCurrentRedemptionReleaseAbsent(input) {
      return db.transaction(async (tx) => {
        const build = await requireAttempt(tx, input);
        if (
          build.consumed_attempt_id !== input.attemptId ||
          build.execution_requested_at === null ||
          build.signed_transaction === null ||
          build.signature === null
        )
          throw conflict("Redemption release has no accepted signed attempt");
        // Keep the first miss: only a later miss may complete the absence proof.
        const updated = await tx.queryOne<EarnWalletWithdrawalRequestTransactionRow>(
          `UPDATE earn_wallet_withdrawal_request_transactions
           SET release_absence_observed_at = COALESCE(release_absence_observed_at, sdp_iso_now()),
             updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND environment = ?
             AND release_finalized_at IS NULL RETURNING *`,
          [input.transactionId, ...values(input)]
        );
        if (updated === null) throw conflict("Redemption release already finalized");
        return { ...updated, last_valid_block_height: String(updated.last_valid_block_height) };
      });
    },
  };
}
