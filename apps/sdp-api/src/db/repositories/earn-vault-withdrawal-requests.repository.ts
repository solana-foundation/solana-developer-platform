import type { SdpEnvironment } from "@sdp/types";
import { type AppDb, asTransactionalClient, type DatabaseExecutor } from "@/db";
import { queuedFulfillmentMovementId } from "@/db/repositories/earn-movements.repository";
import { conflict } from "@/lib/errors";

export type EarnVaultWithdrawalRequestStatus =
  | "creating"
  | "pending"
  | "fulfillable"
  | "expired_cancelable"
  | "cancelling"
  | "closed_or_unknown"
  | "fulfilled"
  | "cancelled"
  | "failed";

export type EarnVaultWithdrawalRequestActionKind = "request" | "cancel";
export type EarnVaultWithdrawalRequestActionStatus =
  | "requested"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed";

export interface EarnVaultWithdrawalRequestRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  position_id: string;
  custody_wallet_id: string | null;
  owner_address: string;
  vault_address: string;
  token_mint: string;
  share_mint: string;
  request_address: string;
  status: EarnVaultWithdrawalRequestStatus;
  shares: string;
  quoted_assets: string;
  share_decimals: number;
  asset_decimals: number;
  discount_bps: number;
  nonce: string | null;
  creation_timestamp: string | null;
  maturity_timestamp: string;
  deadline_timestamp: string;
  client_request_id: string;
  idempotency_fingerprint: string;
  creation_signature: string | null;
  cancel_signature: string | null;
  closing_signature: string | null;
  assets_paid: string | null;
  failure_reason: string | null;
  last_index_error: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
}

export interface EarnVaultWithdrawalRequestActionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  withdrawal_request_id: string;
  action: EarnVaultWithdrawalRequestActionKind;
  status: EarnVaultWithdrawalRequestActionStatus;
  signature: string;
  signed_transaction: string;
  last_valid_block_height: string;
  client_request_id: string;
  idempotency_fingerprint: string;
  failure_reason: string | null;
  confirmed_at: string | null;
  settled_at: string | null;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  unknown_signature_observed_at: string | null;
}

export interface EarnExternalWalletWithdrawalRequestTransactionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  position_id: string | null;
  withdrawal_request_id: string | null;
  action: EarnVaultWithdrawalRequestActionKind;
  owner_address: string;
  vault_address: string;
  token_mint: string;
  share_mint: string;
  request_address: string;
  shares: string | null;
  quoted_assets: string | null;
  share_decimals: number | null;
  asset_decimals: number | null;
  discount_bps: number | null;
  maturity_timestamp: string | null;
  deadline_timestamp: string | null;
  fee_payer: string | null;
  unsigned_transaction: string;
  last_valid_block_height: string;
  consumed_action_id: string | null;
  consumed_at: string | null;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export const EARN_VAULT_WITHDRAWAL_REQUEST_ID_PREFIX = "earn_vault_withdrawal_request_";
export const EARN_VAULT_WITHDRAWAL_ACTION_ID_PREFIX = "earn_vault_withdrawal_action_";
export const EARN_VAULT_WITHDRAWAL_RESERVATION_ID_PREFIX = "earn_vault_withdrawal_reservation_";
export const EARN_EXTERNAL_WALLET_WITHDRAWAL_REQUEST_TRANSACTION_ID_PREFIX =
  "earn_external_wallet_withdrawal_request_transaction_";

export function generateEarnVaultWithdrawalRequestId(): string {
  return `${EARN_VAULT_WITHDRAWAL_REQUEST_ID_PREFIX}${crypto.randomUUID()}`;
}

export function generateEarnVaultWithdrawalRequestActionId(): string {
  return `${EARN_VAULT_WITHDRAWAL_ACTION_ID_PREFIX}${crypto.randomUUID()}`;
}

export function generateEarnVaultWithdrawalRequestReservationId(): string {
  return `${EARN_VAULT_WITHDRAWAL_RESERVATION_ID_PREFIX}${crypto.randomUUID()}`;
}

export function generateEarnExternalWalletWithdrawalRequestTransactionId(): string {
  return `${EARN_EXTERNAL_WALLET_WITHDRAWAL_REQUEST_TRANSACTION_ID_PREFIX}${crypto.randomUUID()}`;
}

export interface CreateSignedQueuedWithdrawalRequestInput {
  requestId: string;
  actionId: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  positionId: string;
  custodyWalletId?: string | null;
  ownerAddress: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  requestAddress: string;
  shares: string;
  quotedAssets: string;
  shareDecimals: number;
  assetDecimals: number;
  discountBps: number;
  maturityTimestamp: string;
  deadlineTimestamp: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  clientRequestId: string;
  idempotencyFingerprint: string;
  /** Exact transient shared-PDA lease that this signed request is promoting. */
  pdaLeaseToken: string;
  externalWalletTransactionId?: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface CreateSignedQueuedWithdrawalCancelInput {
  actionId: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  withdrawalRequestId: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  clientRequestId: string;
  idempotencyFingerprint: string;
  externalWalletTransactionId?: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface CreateExternalWalletQueuedTransactionInput {
  id: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  positionId?: string | null;
  withdrawalRequestId?: string | null;
  action: EarnVaultWithdrawalRequestActionKind;
  ownerAddress: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  requestAddress: string;
  shares?: string | null;
  quotedAssets?: string | null;
  shareDecimals?: number | null;
  assetDecimals?: number | null;
  discountBps?: number | null;
  maturityTimestamp?: string | null;
  deadlineTimestamp?: string | null;
  feePayer?: string | null;
  unsignedTransaction: string;
  lastValidBlockHeight: string;
  /** Confirmed height used to reap an abandoned build for this same PDA. */
  currentBlockHeight?: string;
  reservationExpiresAt?: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface FailQueuedWithdrawalActionInput {
  actionId: string;
  organizationId: string;
  failureReason: string;
  nonce?: string | null;
  creationTimestamp?: string | null;
  quotedAssets?: string | null;
  maturityTimestamp?: string | null;
  deadlineTimestamp?: string | null;
  lastIndexError?: string | null;
}

export interface EarnVaultWithdrawalRequestsRepository {
  acquireRequestReservation(input: {
    id: string;
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    provider: string;
    vaultAddress: string;
    ownerAddress: string;
    requestAddress: string;
    clientRequestId: string;
    idempotencyFingerprint: string;
    expiresAt: string;
    lastValidBlockHeight?: string | null;
  }): Promise<void>;
  releaseRequestReservation(params: { id: string; organizationId: string }): Promise<void>;
  findByClientRequestId(params: {
    organizationId: string;
    clientRequestId: string;
  }): Promise<EarnVaultWithdrawalRequestRow | null>;
  getById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    withdrawalRequestId: string;
  }): Promise<EarnVaultWithdrawalRequestRow | null>;
  getByAddress(params: {
    environment: SdpEnvironment;
    provider: string;
    requestAddress: string;
  }): Promise<EarnVaultWithdrawalRequestRow | null>;
  list(params: {
    organizationId: string;
    environment: SdpEnvironment;
    projectId?: string;
    custodyWalletIds?: readonly string[];
    externalWalletOnly?: boolean;
    ownerAddress?: string;
    status?: EarnVaultWithdrawalRequestStatus;
    settled?: boolean;
    before?: { createdAt: string; id: string };
    limit: number;
  }): Promise<{ rows: EarnVaultWithdrawalRequestRow[]; hasMore: boolean }>;
  createSignedRequest(input: CreateSignedQueuedWithdrawalRequestInput): Promise<{
    request: EarnVaultWithdrawalRequestRow;
    action: EarnVaultWithdrawalRequestActionRow;
    replayed: boolean;
  }>;
  createSignedCancel(input: CreateSignedQueuedWithdrawalCancelInput): Promise<{
    request: EarnVaultWithdrawalRequestRow;
    action: EarnVaultWithdrawalRequestActionRow;
    replayed: boolean;
  }>;
  getActionByClientRequestId(params: {
    organizationId: string;
    clientRequestId: string;
  }): Promise<EarnVaultWithdrawalRequestActionRow | null>;
  getLatestAction(params: {
    withdrawalRequestId: string;
    action: EarnVaultWithdrawalRequestActionKind;
  }): Promise<EarnVaultWithdrawalRequestActionRow | null>;
  advanceAction(input: {
    actionId: string;
    organizationId: string;
    toStatus: EarnVaultWithdrawalRequestActionStatus;
    failureReason?: string | null;
  }): Promise<EarnVaultWithdrawalRequestActionRow | null>;
  failActionAndRecoverRequest(input: FailQueuedWithdrawalActionInput): Promise<{
    action: EarnVaultWithdrawalRequestActionRow;
    request: EarnVaultWithdrawalRequestRow;
  } | null>;
  observeExpiredUnknownSignature(input: {
    actionId: string;
    organizationId: string;
  }): Promise<"first" | "repeat" | "gone">;
  advanceRequest(input: {
    withdrawalRequestId: string;
    organizationId: string;
    toStatus: EarnVaultWithdrawalRequestStatus;
    nonce?: string | null;
    creationTimestamp?: string | null;
    quotedAssets?: string | null;
    maturityTimestamp?: string | null;
    deadlineTimestamp?: string | null;
    closingSignature?: string | null;
    assetsPaid?: string | null;
    failureReason?: string | null;
    lastIndexError?: string | null;
    fulfilledAt?: string | null;
    cancelledAt?: string | null;
  }): Promise<EarnVaultWithdrawalRequestRow | null>;
  recordIndexError(input: { withdrawalRequestId: string; error: string }): Promise<void>;
  claimUnsettledActions(limit: number): Promise<EarnVaultWithdrawalRequestActionRow[]>;
  claimOpenRequests(limit: number): Promise<EarnVaultWithdrawalRequestRow[]>;
  cleanupExpiredReservations(): Promise<number>;
  cleanupExpiredExternalBuilds(params: {
    environment: SdpEnvironment;
    currentBlockHeight: string;
  }): Promise<number>;
  createExternalWalletTransaction(
    input: CreateExternalWalletQueuedTransactionInput
  ): Promise<EarnExternalWalletWithdrawalRequestTransactionRow>;
  getExternalWalletTransaction(params: {
    organizationId: string;
    transactionId: string;
  }): Promise<EarnExternalWalletWithdrawalRequestTransactionRow | null>;
}

function mapRequest(row: Record<string, unknown>): EarnVaultWithdrawalRequestRow {
  return {
    ...(row as unknown as EarnVaultWithdrawalRequestRow),
    share_decimals: Number(row.share_decimals),
    asset_decimals: Number(row.asset_decimals),
    discount_bps: Number(row.discount_bps),
    nonce: row.nonce === null || row.nonce === undefined ? null : String(row.nonce),
    creation_timestamp:
      row.creation_timestamp === null || row.creation_timestamp === undefined
        ? null
        : String(row.creation_timestamp),
    maturity_timestamp: String(row.maturity_timestamp),
    deadline_timestamp: String(row.deadline_timestamp),
  };
}

function mapAction(row: Record<string, unknown>): EarnVaultWithdrawalRequestActionRow {
  return {
    ...(row as unknown as EarnVaultWithdrawalRequestActionRow),
    last_valid_block_height: String(row.last_valid_block_height),
  };
}

function mapExternalBuild(
  row: Record<string, unknown>
): EarnExternalWalletWithdrawalRequestTransactionRow {
  return {
    ...(row as unknown as EarnExternalWalletWithdrawalRequestTransactionRow),
    share_decimals: row.share_decimals == null ? null : Number(row.share_decimals),
    asset_decimals: row.asset_decimals == null ? null : Number(row.asset_decimals),
    discount_bps: row.discount_bps == null ? null : Number(row.discount_bps),
    maturity_timestamp: row.maturity_timestamp == null ? null : String(row.maturity_timestamp),
    deadline_timestamp: row.deadline_timestamp == null ? null : String(row.deadline_timestamp),
    last_valid_block_height: String(row.last_valid_block_height),
  };
}

const ACTION_SOURCES: Record<
  EarnVaultWithdrawalRequestActionStatus,
  readonly EarnVaultWithdrawalRequestActionStatus[]
> = {
  requested: [],
  submitted: ["requested"],
  confirmed: ["requested", "submitted"],
  finalized: ["requested", "submitted", "confirmed"],
  failed: ["requested", "submitted"],
};

const REQUEST_SOURCES: Record<
  EarnVaultWithdrawalRequestStatus,
  readonly EarnVaultWithdrawalRequestStatus[]
> = {
  creating: [],
  pending: ["creating", "pending", "closed_or_unknown"],
  fulfillable: ["creating", "pending", "fulfillable", "closed_or_unknown"],
  // A synchronous cancel eligibility read may be the first observer after a
  // finalized request transaction. Permit it to close the short `creating`
  // window instead of making recovery wait for the background sweep.
  expired_cancelable: [
    "creating",
    "pending",
    "fulfillable",
    "expired_cancelable",
    "cancelling",
    "closed_or_unknown",
  ],
  cancelling: ["expired_cancelable", "cancelling"],
  closed_or_unknown: [
    "creating",
    "pending",
    "fulfillable",
    "expired_cancelable",
    "cancelling",
    "closed_or_unknown",
  ],
  fulfilled: [
    "creating",
    "pending",
    "fulfillable",
    "expired_cancelable",
    "cancelling",
    "closed_or_unknown",
  ],
  cancelled: [
    "creating",
    "pending",
    "fulfillable",
    "expired_cancelable",
    "cancelling",
    "closed_or_unknown",
  ],
  failed: ["creating"],
};

async function findRequestByClientRequestId(
  db: DatabaseExecutor,
  organizationId: string,
  clientRequestId: string
): Promise<EarnVaultWithdrawalRequestRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM earn_vault_withdrawal_requests
        WHERE organization_id = ? AND client_request_id = ?`
    )
    .bind(organizationId, clientRequestId)
    .first<Record<string, unknown>>();
  return row ? mapRequest(row) : null;
}

async function getActionByClientRequestId(
  db: DatabaseExecutor,
  organizationId: string,
  clientRequestId: string
): Promise<EarnVaultWithdrawalRequestActionRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM earn_vault_withdrawal_request_actions
        WHERE organization_id = ? AND client_request_id = ?`
    )
    .bind(organizationId, clientRequestId)
    .first<Record<string, unknown>>();
  return row ? mapAction(row) : null;
}

function assertFingerprint(row: { idempotency_fingerprint: string }, fingerprint: string): void {
  if (row.idempotency_fingerprint !== fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
}

async function lockQueuedWithdrawalKey(
  db: DatabaseExecutor,
  scope: "client" | "pda",
  key: string
): Promise<void> {
  // Keep caller-controlled idempotency hashes in a different PostgreSQL lock
  // namespace from provider PDA hashes. Every request then has one stable lock
  // order (client -> PDA), even if the two strings have the same 32-bit hash.
  const namespace = scope === "client" ? 1 : 2;
  await db
    .prepare("SELECT pg_advisory_xact_lock(?::int, hashtext(?))")
    .bind(namespace, key)
    .first();
}

async function consumeExternalBuild(
  db: DatabaseExecutor,
  transactionId: string | undefined,
  organizationId: string,
  actionId: string
): Promise<void> {
  if (!transactionId) return;
  const build = await db
    .prepare(
      `SELECT id, consumed_action_id, action
         FROM earn_external_wallet_withdrawal_request_transactions
        WHERE id = ? AND organization_id = ?
        FOR UPDATE`
    )
    .bind(transactionId, organizationId)
    .first<{
      id: string;
      consumed_action_id: string | null;
      action: EarnVaultWithdrawalRequestActionKind;
    }>();
  if (!build) throw new Error(`Missing queued withdrawal build ${transactionId}`);
  if (build.consumed_action_id !== null && build.consumed_action_id !== actionId) {
    throw conflict("This transaction was already submitted under a different idempotency key");
  }
  const changed = await db
    .prepare(
      `UPDATE earn_external_wallet_withdrawal_request_transactions
          SET consumed_action_id = ?, consumed_at = sdp_iso_now(), updated_at = sdp_iso_now()
        WHERE id = ? AND consumed_action_id IS NULL`
    )
    .bind(actionId, transactionId)
    .run();
  if (changed !== 1 && build.consumed_action_id === null) {
    throw new Error(`Queued withdrawal build ${transactionId} was consumed concurrently`);
  }
  if (build.action === "request") {
    await db
      .prepare(`DELETE FROM earn_vault_withdrawal_request_reservations WHERE id = ?`)
      .bind(build.id)
      .run();
  }
}

/**
 * Convert a transient builder lease into the public chain identity's durable
 * occupancy claim. The claim is shared rather than tenant-scoped because a
 * deterministic PDA cannot be reused by another organization merely because
 * RLS hides the first organization's request row.
 */
async function promoteRequestAddressLease(
  db: DatabaseExecutor,
  request: {
    id: string;
    environment: SdpEnvironment;
    requestAddress: string;
    expectedLeaseToken: string;
  }
): Promise<void> {
  const promoted = await db
    .prepare(
      `UPDATE earn_vault_withdrawal_request_pda_leases
          SET lease_token = ?, expires_at = '9999-12-31T23:59:59.999Z',
              last_valid_block_height = NULL, occupied = TRUE
        WHERE environment = ? AND request_address = ?
          AND lease_token = ? AND NOT occupied
          AND expires_at > sdp_iso_now()
        RETURNING lease_token`
    )
    .bind(request.id, request.environment, request.requestAddress, request.expectedLeaseToken)
    .first<{ lease_token: string }>();
  if (promoted?.lease_token !== request.id) {
    throw conflict(
      "This queued withdrawal build no longer owns its provider nonce. Build and sign a fresh transaction."
    );
  }
}

/**
 * Persist a fulfilled queued withdrawal's payout as one idempotent
 * earn_movements row, in the same transaction that moved the request to
 * `fulfilled`. Mirrors the read-side projection field for field — including
 * `created_at` = settlement time — so the ledger row and the synthetic
 * fallback for pre-persistence history render identically. Replaying the same
 * fulfillment (same request, same closing signature) resolves to the same
 * primary key and inserts nothing.
 *
 * `token_amount_settled` guards zero payouts to NULL: the movement CHECK (and
 * 0103's semantics) treat zero as "payout not observed", never a stated fact.
 *
 * `owner_address` follows the ledger's exactly-one-of signer rule (0070): it
 * is bound only for external-wallet fulfillments, whose owner-scoped ledger
 * reads and earned aggregates filter on it. A custody fulfillment keeps it
 * NULL — setting both would activate the external-wallet claim foreign key
 * against a custody position row that has no owner address. Either way the
 * payout's destination is recorded in destination_address.
 */
async function recordFulfilledQueueMovement(
  tx: DatabaseExecutor,
  request: EarnVaultWithdrawalRequestRow
): Promise<void> {
  if (!request.closing_signature) return;
  const settledAt = request.fulfilled_at ?? request.updated_at;
  const ownerAddress = request.custody_wallet_id ? null : request.owner_address;
  await tx
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id,
         status, confirmed_at, settled_at,
         denomination, amount_requested, amount_settled, token_amount_settled,
         custody_wallet_id, owner_address, vault_address, source_address, destination_address,
         provider_reference, signature,
         request_id, idempotency_fingerprint, provider_data,
         created_by, initiated_by_key_id,
         creates_share_account, share_ata_rent_funder, unknown_signature_observed_at,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         'vault_direct', 'withdrawal', ?,
         'finalized', ?, ?,
         ?, ?, ?, CASE WHEN ? ~ '[1-9]' THEN ? ELSE NULL END,
         ?, ?, ?, NULL, ?,
         ?, ?,
         ?, ?, ?::jsonb,
         ?, ?,
         FALSE, NULL, NULL,
         ?, ?
       )
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(
      queuedFulfillmentMovementId(request.id),
      request.organization_id,
      request.project_id,
      request.environment,
      request.provider,
      request.position_id,
      settledAt,
      settledAt,
      request.share_mint,
      request.shares,
      request.shares,
      request.assets_paid,
      request.assets_paid,
      request.custody_wallet_id,
      ownerAddress,
      request.vault_address,
      request.owner_address,
      request.request_address,
      request.closing_signature,
      request.client_request_id,
      request.idempotency_fingerprint,
      JSON.stringify({
        observation: "provider_solver_fulfillment",
        withdrawalRequestId: request.id,
        requestAddress: request.request_address,
        nonce: request.nonce,
      }),
      request.created_by,
      request.initiated_by_key_id,
      settledAt,
      request.updated_at
    )
    .run();
}

export function createPostgresEarnVaultWithdrawalRequestsRepository(
  db: AppDb
): EarnVaultWithdrawalRequestsRepository {
  return {
    async acquireRequestReservation(input) {
      await db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        await tx
          .prepare(
            `DELETE FROM earn_vault_withdrawal_request_reservations
              WHERE environment = ? AND request_address = ?
                AND expires_at <= sdp_iso_now()`
          )
          .bind(input.environment, input.requestAddress)
          .run();
        const recorded = await tx
          .prepare(
            `SELECT id FROM earn_vault_withdrawal_requests
              WHERE environment = ? AND request_address = ? AND status <> 'failed'`
          )
          .bind(input.environment, input.requestAddress)
          .first<{ id: string }>();
        if (recorded) {
          throw conflict("A queued withdrawal already uses this provider request address");
        }
        const lease = await tx
          .prepare(
            `INSERT INTO earn_vault_withdrawal_request_pda_leases (
               environment, request_address, lease_token, expires_at,
               last_valid_block_height
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (environment, request_address) DO UPDATE SET
               lease_token = EXCLUDED.lease_token,
               expires_at = EXCLUDED.expires_at,
               last_valid_block_height = EXCLUDED.last_valid_block_height
             WHERE NOT earn_vault_withdrawal_request_pda_leases.occupied
               AND earn_vault_withdrawal_request_pda_leases.expires_at <= sdp_iso_now()
             RETURNING lease_token`
          )
          .bind(
            input.environment,
            input.requestAddress,
            input.id,
            input.expiresAt,
            input.lastValidBlockHeight ?? null
          )
          .first<{ lease_token: string }>();
        if (!lease || lease.lease_token !== input.id) {
          throw conflict(
            "Another queued withdrawal build is already reserving this provider nonce; retry shortly"
          );
        }
        const inserted = await tx
          .prepare(
            `INSERT INTO earn_vault_withdrawal_request_reservations (
               id, organization_id, project_id, environment, provider,
               vault_address, owner_address, request_address, client_request_id,
               idempotency_fingerprint, expires_at, last_valid_block_height
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`
          )
          .bind(
            input.id,
            input.organizationId,
            input.projectId,
            input.environment,
            input.provider,
            input.vaultAddress,
            input.ownerAddress,
            input.requestAddress,
            input.clientRequestId,
            input.idempotencyFingerprint,
            input.expiresAt,
            input.lastValidBlockHeight ?? null
          )
          .first<{ id: string }>();
        if (!inserted) throw new Error("Failed to record queued withdrawal reservation");
      });
    },

    async releaseRequestReservation(params) {
      await db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        await tx
          .prepare(
            `DELETE FROM earn_vault_withdrawal_request_reservations
              WHERE id = ? AND organization_id = ?`
          )
          .bind(params.id, params.organizationId)
          .run();
        await tx
          .prepare(
            `DELETE FROM earn_vault_withdrawal_request_pda_leases
              WHERE lease_token = ? AND NOT occupied`
          )
          .bind(params.id)
          .run();
      });
    },

    async findByClientRequestId(params) {
      return findRequestByClientRequestId(db, params.organizationId, params.clientRequestId);
    },

    async getById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE id = ? AND organization_id = ? AND environment = ?`
        )
        .bind(params.withdrawalRequestId, params.organizationId, params.environment)
        .first<Record<string, unknown>>();
      return row ? mapRequest(row) : null;
    },

    async getByAddress(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE environment = ? AND provider = ? AND request_address = ?
              AND status <> 'failed'`
        )
        .bind(params.environment, params.provider, params.requestAddress)
        .first<Record<string, unknown>>();
      return row ? mapRequest(row) : null;
    },

    async list(params) {
      const conditions = ["organization_id = ?", "environment = ?"];
      const bindings: unknown[] = [params.organizationId, params.environment];
      if (params.projectId !== undefined) {
        conditions.push("project_id = ?");
        bindings.push(params.projectId);
      }
      if (params.custodyWalletIds !== undefined) {
        if (params.custodyWalletIds.length === 0) return { rows: [], hasMore: false };
        conditions.push("custody_wallet_id = ANY (?::text[])");
        bindings.push([...params.custodyWalletIds]);
      }
      if (params.externalWalletOnly) {
        conditions.push("custody_wallet_id IS NULL");
      }
      if (params.ownerAddress !== undefined) {
        conditions.push("owner_address = ?");
        bindings.push(params.ownerAddress);
      }
      if (params.status !== undefined) {
        conditions.push("status = ?");
        bindings.push(params.status);
      }
      if (params.settled !== undefined) {
        conditions.push(
          params.settled
            ? "status IN ('fulfilled', 'cancelled', 'failed')"
            : `status IN (
                'creating', 'pending', 'fulfillable', 'expired_cancelable',
                'cancelling', 'closed_or_unknown'
              )`
        );
      }
      if (params.before !== undefined) {
        conditions.push("(created_at, id) < (?, ?)");
        bindings.push(params.before.createdAt, params.before.id);
      }
      bindings.push(params.limit + 1);
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE ${conditions.join(" AND ")}
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(...bindings)
        .all<Record<string, unknown>>();
      const rows = result.results.map(mapRequest);
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async createSignedRequest(input) {
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        await lockQueuedWithdrawalKey(
          tx,
          "client",
          `${input.organizationId}:${input.clientRequestId}`
        );
        await lockQueuedWithdrawalKey(tx, "pda", `${input.environment}:${input.requestAddress}`);
        const existing = await findRequestByClientRequestId(
          tx,
          input.organizationId,
          input.clientRequestId
        );
        if (existing) {
          assertFingerprint(existing, input.idempotencyFingerprint);
          if (existing.project_id !== input.projectId) {
            throw conflict("Idempotency key already used with different request payload");
          }
          const action = await getActionByClientRequestId(
            tx,
            input.organizationId,
            input.clientRequestId
          );
          if (
            !action ||
            action.withdrawal_request_id !== existing.id ||
            action.action !== "request" ||
            action.project_id !== input.projectId
          ) {
            throw new Error(`Queued withdrawal ${existing.id} has no matching request action`);
          }
          await consumeExternalBuild(
            tx,
            input.externalWalletTransactionId,
            input.organizationId,
            action.id
          );
          return { request: existing, action, replayed: true };
        }

        const recordedAddress = await tx
          .prepare(
            `SELECT id FROM earn_vault_withdrawal_requests
              WHERE environment = ? AND request_address = ? AND status <> 'failed'`
          )
          .bind(input.environment, input.requestAddress)
          .first<{ id: string }>();
        if (recordedAddress) {
          throw conflict("A queued withdrawal already uses this provider request address");
        }

        const requestRow = await tx
          .prepare(
            `INSERT INTO earn_vault_withdrawal_requests (
               id, organization_id, project_id, environment, provider, position_id,
               custody_wallet_id, owner_address, vault_address, token_mint, share_mint,
               request_address, status, shares, quoted_assets, share_decimals, asset_decimals,
               discount_bps, maturity_timestamp, deadline_timestamp,
               client_request_id, idempotency_fingerprint, creation_signature,
               created_by, initiated_by_key_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`
          )
          .bind(
            input.requestId,
            input.organizationId,
            input.projectId,
            input.environment,
            input.provider,
            input.positionId,
            input.custodyWalletId ?? null,
            input.ownerAddress,
            input.vaultAddress,
            input.tokenMint,
            input.shareMint,
            input.requestAddress,
            input.shares,
            input.quotedAssets,
            input.shareDecimals,
            input.assetDecimals,
            input.discountBps,
            input.maturityTimestamp,
            input.deadlineTimestamp,
            input.clientRequestId,
            input.idempotencyFingerprint,
            input.signature,
            input.createdBy ?? null,
            input.initiatedByKeyId ?? null
          )
          .first<Record<string, unknown>>();
        if (!requestRow) throw new Error("Failed to record queued withdrawal request");

        const actionRow = await tx
          .prepare(
            `INSERT INTO earn_vault_withdrawal_request_actions (
               id, organization_id, project_id, environment, withdrawal_request_id,
               action, status, signature, signed_transaction, last_valid_block_height,
               client_request_id, idempotency_fingerprint, created_by, initiated_by_key_id
             ) VALUES (?, ?, ?, ?, ?, 'request', 'requested', ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`
          )
          .bind(
            input.actionId,
            input.organizationId,
            input.projectId,
            input.environment,
            input.requestId,
            input.signature,
            input.signedTransaction,
            input.lastValidBlockHeight,
            input.clientRequestId,
            input.idempotencyFingerprint,
            input.createdBy ?? null,
            input.initiatedByKeyId ?? null
          )
          .first<Record<string, unknown>>();
        if (!actionRow) throw new Error("Failed to record queued withdrawal request action");
        await consumeExternalBuild(
          tx,
          input.externalWalletTransactionId,
          input.organizationId,
          input.actionId
        );
        await promoteRequestAddressLease(tx, {
          id: input.requestId,
          environment: input.environment,
          requestAddress: input.requestAddress,
          expectedLeaseToken: input.pdaLeaseToken,
        });
        return { request: mapRequest(requestRow), action: mapAction(actionRow), replayed: false };
      });
    },

    async createSignedCancel(input) {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: replay, build consumption, and request/action CAS must remain one atomic transaction.
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        await lockQueuedWithdrawalKey(
          tx,
          "client",
          `${input.organizationId}:${input.clientRequestId}`
        );
        const built = input.externalWalletTransactionId
          ? await tx
              .prepare(
                `SELECT id, consumed_action_id
                   FROM earn_external_wallet_withdrawal_request_transactions
                  WHERE id = ? AND organization_id = ? FOR UPDATE`
              )
              .bind(input.externalWalletTransactionId, input.organizationId)
              .first<{ id: string; consumed_action_id: string | null }>()
          : null;
        if (input.externalWalletTransactionId && !built) {
          throw new Error(`Missing queued withdrawal build ${input.externalWalletTransactionId}`);
        }
        const existingAction = await getActionByClientRequestId(
          tx,
          input.organizationId,
          input.clientRequestId
        );
        if (existingAction) {
          assertFingerprint(existingAction, input.idempotencyFingerprint);
          if (
            existingAction.withdrawal_request_id !== input.withdrawalRequestId ||
            existingAction.action !== "cancel"
          ) {
            throw conflict("Idempotency key already used with different request payload");
          }
          await consumeExternalBuild(
            tx,
            input.externalWalletTransactionId,
            input.organizationId,
            existingAction.id
          );
          const request = await tx
            .prepare(
              `SELECT * FROM earn_vault_withdrawal_requests
                WHERE id = ? AND organization_id = ?`
            )
            .bind(input.withdrawalRequestId, input.organizationId)
            .first<Record<string, unknown>>();
          if (!request) throw new Error(`Missing queued withdrawal ${input.withdrawalRequestId}`);
          return { request: mapRequest(request), action: existingAction, replayed: true };
        }

        const locked = await tx
          .prepare(
            `SELECT * FROM earn_vault_withdrawal_requests
              WHERE id = ? AND organization_id = ? AND environment = ?
              FOR UPDATE`
          )
          .bind(input.withdrawalRequestId, input.organizationId, input.environment)
          .first<Record<string, unknown>>();
        if (!locked) throw new Error(`Missing queued withdrawal ${input.withdrawalRequestId}`);
        const request = mapRequest(locked);
        if (request.status !== "expired_cancelable") {
          throw conflict(`Queued withdrawal cannot be cancelled while status is ${request.status}`);
        }

        const actionRow = await tx
          .prepare(
            `INSERT INTO earn_vault_withdrawal_request_actions (
               id, organization_id, project_id, environment, withdrawal_request_id,
               action, status, signature, signed_transaction, last_valid_block_height,
               client_request_id, idempotency_fingerprint, created_by, initiated_by_key_id
             ) VALUES (?, ?, ?, ?, ?, 'cancel', 'requested', ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`
          )
          .bind(
            input.actionId,
            input.organizationId,
            input.projectId,
            input.environment,
            input.withdrawalRequestId,
            input.signature,
            input.signedTransaction,
            input.lastValidBlockHeight,
            input.clientRequestId,
            input.idempotencyFingerprint,
            input.createdBy ?? null,
            input.initiatedByKeyId ?? null
          )
          .first<Record<string, unknown>>();
        if (!actionRow) throw new Error("Failed to record queued withdrawal cancellation");
        const updated = await tx
          .prepare(
            `UPDATE earn_vault_withdrawal_requests
                SET status = 'cancelling', cancel_signature = ?,
                    failure_reason = NULL, updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ? AND status = 'expired_cancelable'
              RETURNING *`
          )
          .bind(input.signature, input.withdrawalRequestId, input.organizationId)
          .first<Record<string, unknown>>();
        if (!updated) throw conflict("Queued withdrawal status changed before cancellation");
        await consumeExternalBuild(
          tx,
          input.externalWalletTransactionId,
          input.organizationId,
          input.actionId
        );
        return { request: mapRequest(updated), action: mapAction(actionRow), replayed: false };
      });
    },

    async getActionByClientRequestId(params) {
      return getActionByClientRequestId(db, params.organizationId, params.clientRequestId);
    },

    async getLatestAction(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_request_actions
            WHERE withdrawal_request_id = ? AND action = ?
            ORDER BY created_at DESC, id DESC LIMIT 1`
        )
        .bind(params.withdrawalRequestId, params.action)
        .first<Record<string, unknown>>();
      return row ? mapAction(row) : null;
    },

    async advanceAction(input) {
      const sources = ACTION_SOURCES[input.toStatus];
      if (sources.length === 0) return null;
      const nowConfirmed = input.toStatus === "confirmed" || input.toStatus === "finalized";
      const row = await db
        .prepare(
          `UPDATE earn_vault_withdrawal_request_actions
              SET status = ?,
                  failure_reason = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
                  confirmed_at = CASE WHEN ? THEN COALESCE(confirmed_at, sdp_iso_now()) ELSE NULL END,
                  settled_at = CASE WHEN ? = 'finalized' THEN sdp_iso_now() ELSE NULL END,
                  unknown_signature_observed_at = NULL,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND status = ANY (?::text[])
            RETURNING *`
        )
        .bind(
          input.toStatus,
          input.toStatus,
          input.failureReason ?? null,
          nowConfirmed,
          input.toStatus,
          input.actionId,
          input.organizationId,
          [...sources]
        )
        .first<Record<string, unknown>>();
      return row ? mapAction(row) : null;
    },

    async failActionAndRecoverRequest(input) {
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        const actionRow = await tx
          .prepare(
            `UPDATE earn_vault_withdrawal_request_actions
                SET status = 'failed', failure_reason = ?,
                    confirmed_at = NULL, settled_at = NULL,
                    unknown_signature_observed_at = NULL,
                    updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ?
                AND status = ANY (?::text[])
              RETURNING *`
          )
          .bind(input.failureReason, input.actionId, input.organizationId, [
            "requested",
            "submitted",
          ])
          .first<Record<string, unknown>>();
        if (!actionRow) return null;
        const action = mapAction(actionRow);
        const requestStatus = action.action === "request" ? "failed" : "expired_cancelable";
        const requestRow = await tx
          .prepare(
            `UPDATE earn_vault_withdrawal_requests
                SET status = ?,
                    nonce = COALESCE(?, nonce),
                    creation_timestamp = COALESCE(?, creation_timestamp),
                    quoted_assets = COALESCE(?, quoted_assets),
                    maturity_timestamp = COALESCE(?, maturity_timestamp),
                    deadline_timestamp = COALESCE(?, deadline_timestamp),
                    failure_reason = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
                    last_index_error = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ?
                AND status = ANY (?::text[])
              RETURNING *`
          )
          .bind(
            requestStatus,
            input.nonce ?? null,
            input.creationTimestamp ?? null,
            input.quotedAssets ?? null,
            input.maturityTimestamp ?? null,
            input.deadlineTimestamp ?? null,
            requestStatus,
            action.action === "request" ? input.failureReason : null,
            input.lastIndexError ?? null,
            action.withdrawal_request_id,
            input.organizationId,
            [...REQUEST_SOURCES[requestStatus]]
          )
          .first<Record<string, unknown>>();
        if (!requestRow) {
          if (action.action === "cancel") {
            const terminalRow = await tx
              .prepare(
                `SELECT * FROM earn_vault_withdrawal_requests
                  WHERE id = ? AND organization_id = ?
                    AND status IN ('fulfilled', 'cancelled', 'failed')
                  FOR UPDATE`
              )
              .bind(action.withdrawal_request_id, input.organizationId)
              .first<Record<string, unknown>>();
            if (terminalRow) {
              return { action, request: mapRequest(terminalRow) };
            }
          }
          throw new Error(
            `Queued withdrawal ${action.withdrawal_request_id} changed before action failure recovery`
          );
        }
        const request = mapRequest(requestRow);
        if (action.action === "request") {
          await tx
            .prepare(
              `DELETE FROM earn_vault_withdrawal_request_pda_leases
                WHERE environment = ? AND request_address = ?
                  AND lease_token = ? AND occupied`
            )
            .bind(request.environment, request.request_address, request.id)
            .run();
        }
        return { action, request };
      });
    },

    async observeExpiredUnknownSignature(input) {
      const first = await db
        .prepare(
          `UPDATE earn_vault_withdrawal_request_actions
              SET unknown_signature_observed_at = sdp_iso_now(),
                  updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND status = 'requested'
              AND unknown_signature_observed_at IS NULL
            RETURNING id`
        )
        .bind(input.actionId, input.organizationId)
        .first<{ id: string }>();
      if (first) return "first";
      const existing = await db
        .prepare(
          `SELECT unknown_signature_observed_at,
                  unknown_signature_observed_at::timestamptz <=
                    clock_timestamp() - INTERVAL '30 seconds' AS old_enough
             FROM earn_vault_withdrawal_request_actions
            WHERE id = ? AND organization_id = ? AND status = 'requested'`
        )
        .bind(input.actionId, input.organizationId)
        .first<{ unknown_signature_observed_at: string | null; old_enough: boolean }>();
      if (!existing?.unknown_signature_observed_at) return "gone";
      return existing.old_enough ? "repeat" : "first";
    },

    async advanceRequest(input) {
      const sources = REQUEST_SOURCES[input.toStatus];
      if (sources.length === 0) return null;
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        const row = await tx
          .prepare(
            `UPDATE earn_vault_withdrawal_requests
              SET status = ?,
                  nonce = COALESCE(?, nonce),
                  creation_timestamp = COALESCE(?, creation_timestamp),
                  quoted_assets = COALESCE(?, quoted_assets),
                  maturity_timestamp = COALESCE(?, maturity_timestamp),
                  deadline_timestamp = COALESCE(?, deadline_timestamp),
                  closing_signature = COALESCE(?, closing_signature),
                  assets_paid = CASE WHEN ? = 'fulfilled' THEN ? ELSE NULL END,
                  failure_reason = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
                  last_index_error = ?,
                  fulfilled_at = CASE WHEN ? = 'fulfilled'
                    THEN COALESCE(?, fulfilled_at, sdp_iso_now()) ELSE NULL END,
                  cancelled_at = CASE WHEN ? = 'cancelled'
                    THEN COALESCE(?, cancelled_at, sdp_iso_now()) ELSE NULL END,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND status = ANY (?::text[])
            RETURNING *`
          )
          .bind(
            input.toStatus,
            input.nonce ?? null,
            input.creationTimestamp ?? null,
            input.quotedAssets ?? null,
            input.maturityTimestamp ?? null,
            input.deadlineTimestamp ?? null,
            input.closingSignature ?? null,
            input.toStatus,
            input.assetsPaid ?? null,
            input.toStatus,
            input.failureReason ?? null,
            input.lastIndexError ?? null,
            input.toStatus,
            input.fulfilledAt ?? null,
            input.toStatus,
            input.cancelledAt ?? null,
            input.withdrawalRequestId,
            input.organizationId,
            [...sources]
          )
          .first<Record<string, unknown>>();
        if (!row) return null;
        const request = mapRequest(row);
        if (input.toStatus === "fulfilled") {
          // The payout belongs in the ONE authoritative ledger
          // (earn_movements), not only in this table's projection: every
          // consumer — /v1/transactions first — reads earn_movements directly.
          // Keyed by the request id and carrying the closing signature, the
          // insert replays as a no-op; the closing signature is unique per
          // fulfillment via idx_earn_movements_signature.
          await recordFulfilledQueueMovement(tx, request);
        }
        if (input.toStatus === "cancelled") {
          // A cancellation can restore a full wallet balance after hydration
          // observed zero escrowed shares. Reopening/bumping the position in
          // this transaction makes that stale close CAS fail.
          await tx
            .prepare(
              `UPDATE earn_positions
                  SET closed_at = NULL, updated_at = sdp_iso_now()
                WHERE id = ? AND organization_id = ?`
            )
            .bind(request.position_id, request.organization_id)
            .run();
        }
        if (input.toStatus === "failed") {
          await tx
            .prepare(
              `DELETE FROM earn_vault_withdrawal_request_pda_leases
                WHERE environment = ? AND request_address = ?
                  AND lease_token = ? AND occupied`
            )
            .bind(request.environment, request.request_address, request.id)
            .run();
        }
        return request;
      });
    },

    async recordIndexError(input) {
      await db
        .prepare(
          `UPDATE earn_vault_withdrawal_requests
              SET last_index_error = ?, updated_at = sdp_iso_now()
            WHERE id = ?`
        )
        .bind(input.error.slice(0, 500), input.withdrawalRequestId)
        .run();
    },

    async claimUnsettledActions(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("Queued withdrawal action claim limit must be from 1 to 256");
      }
      const result = await db
        .prepare(
          // Recovery may legitimately leave an action submitted after its
          // parent request already reached PDA/closing-event terminal truth
          // (a cancel that lost the race to a solver fulfillment). Such an
          // action is settled history, not open work: reclaiming it would
          // push it into signature reconciliation on every sweep forever,
          // eventually starving new recovery out of the bounded batch.
          `WITH candidates AS MATERIALIZED (
             SELECT action.id
               FROM earn_vault_withdrawal_request_actions action
              INNER JOIN earn_vault_withdrawal_requests request
                 ON request.id = action.withdrawal_request_id
              WHERE action.status IN ('requested', 'submitted', 'confirmed')
                AND request.status NOT IN ('fulfilled', 'cancelled', 'failed')
              ORDER BY COALESCE(action.last_checked_at, action.updated_at), action.id
              LIMIT ?
               FOR UPDATE OF action SKIP LOCKED
            )
            UPDATE earn_vault_withdrawal_request_actions action
               SET last_checked_at = sdp_iso_now()
              FROM candidates
             WHERE action.id = candidates.id
             RETURNING action.*`
        )
        .bind(limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapAction);
    },

    async claimOpenRequests(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("Queued withdrawal request claim limit must be from 1 to 256");
      }
      const result = await db
        .prepare(
          `WITH candidates AS MATERIALIZED (
             SELECT request.id
               FROM earn_vault_withdrawal_requests request
              WHERE request.status IN (
                'creating', 'pending', 'fulfillable', 'expired_cancelable',
                'cancelling', 'closed_or_unknown'
              )
                AND EXISTS (
                  SELECT 1 FROM earn_vault_withdrawal_request_actions action
                   WHERE action.withdrawal_request_id = request.id
                     AND action.action = 'request'
                     AND action.status IN ('submitted', 'confirmed', 'finalized')
                )
              ORDER BY COALESCE(request.last_checked_at, request.updated_at), request.id
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           )
           UPDATE earn_vault_withdrawal_requests request
              SET last_checked_at = sdp_iso_now()
             FROM candidates
            WHERE request.id = candidates.id
            RETURNING request.*`
        )
        .bind(limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapRequest);
    },

    async cleanupExpiredReservations() {
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        const result = await tx
          .prepare(
            `DELETE FROM earn_vault_withdrawal_request_reservations
              WHERE last_valid_block_height IS NULL AND expires_at <= sdp_iso_now()`
          )
          .run();
        await tx
          .prepare(
            `DELETE FROM earn_vault_withdrawal_request_pda_leases
              WHERE NOT occupied
                AND last_valid_block_height IS NULL AND expires_at <= sdp_iso_now()`
          )
          .run();
        return result;
      });
    },

    async cleanupExpiredExternalBuilds(params) {
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        const expired = await tx
          .prepare(
            `DELETE FROM earn_external_wallet_withdrawal_request_transactions
              WHERE environment = ? AND consumed_action_id IS NULL
                AND last_valid_block_height < ?
              RETURNING id`
          )
          .bind(params.environment, params.currentBlockHeight)
          .all<{ id: string }>();
        const ids = expired.results.map((row) => row.id);
        if (ids.length > 0) {
          await tx
            .prepare(
              `DELETE FROM earn_vault_withdrawal_request_reservations
                WHERE id = ANY (?::text[])`
            )
            .bind(ids)
            .run();
          await tx
            .prepare(
              `DELETE FROM earn_vault_withdrawal_request_pda_leases
                WHERE lease_token = ANY (?::text[]) AND NOT occupied`
            )
            .bind(ids)
            .run();
        }
        return ids.length;
      });
    },

    async createExternalWalletTransaction(input) {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shared PDA lease acquisition and durable build persistence must remain one atomic transaction.
      return db.transaction(async (executor) => {
        const tx = asTransactionalClient(executor);
        if (input.action === "request") {
          if (input.currentBlockHeight === undefined) {
            throw new Error("Current block height is required for a queued request build");
          }
          await tx
            .prepare(
              `DELETE FROM earn_external_wallet_withdrawal_request_transactions
                WHERE environment = ? AND request_address = ?
                  AND action = 'request' AND consumed_action_id IS NULL
                  AND last_valid_block_height < ?`
            )
            .bind(input.environment, input.requestAddress, input.currentBlockHeight)
            .run();
          await tx
            .prepare(
              `DELETE FROM earn_vault_withdrawal_request_reservations
                WHERE environment = ? AND request_address = ?
                  AND last_valid_block_height < ?`
            )
            .bind(input.environment, input.requestAddress, input.currentBlockHeight)
            .run();
          const recorded = await tx
            .prepare(
              `SELECT id FROM earn_vault_withdrawal_requests
                WHERE environment = ? AND request_address = ? AND status <> 'failed'`
            )
            .bind(input.environment, input.requestAddress)
            .first<{ id: string }>();
          if (recorded) {
            throw conflict("A queued withdrawal already uses this provider request address");
          }
          const leaseExpiresAt =
            input.reservationExpiresAt ?? new Date(Date.now() + 86_400_000).toISOString();
          const lease = await tx
            .prepare(
              `INSERT INTO earn_vault_withdrawal_request_pda_leases (
                 environment, request_address, lease_token, expires_at,
                 last_valid_block_height
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (environment, request_address) DO UPDATE SET
                 lease_token = EXCLUDED.lease_token,
                 expires_at = EXCLUDED.expires_at,
                 last_valid_block_height = EXCLUDED.last_valid_block_height
               WHERE NOT earn_vault_withdrawal_request_pda_leases.occupied
                 AND (
                   earn_vault_withdrawal_request_pda_leases.expires_at <= sdp_iso_now()
                   OR earn_vault_withdrawal_request_pda_leases.last_valid_block_height < ?
                 )
               RETURNING lease_token`
            )
            .bind(
              input.environment,
              input.requestAddress,
              input.id,
              leaseExpiresAt,
              input.lastValidBlockHeight,
              input.currentBlockHeight
            )
            .first<{ lease_token: string }>();
          if (!lease || lease.lease_token !== input.id) {
            throw conflict(
              "Another queued withdrawal build already reserves this provider nonce; retry after it lands or expires"
            );
          }
          const reservation = await tx
            .prepare(
              `INSERT INTO earn_vault_withdrawal_request_reservations (
                 id, organization_id, project_id, environment, provider,
                 vault_address, owner_address, request_address, client_request_id,
                 idempotency_fingerprint, expires_at, last_valid_block_height
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id`
            )
            .bind(
              input.id,
              input.organizationId,
              input.projectId,
              input.environment,
              input.provider,
              input.vaultAddress,
              input.ownerAddress,
              input.requestAddress,
              input.id,
              input.id,
              leaseExpiresAt,
              input.lastValidBlockHeight
            )
            .first<{ id: string }>();
          if (!reservation) {
            throw new Error("Failed to record queued external-wallet withdrawal reservation");
          }
        }
        const row = await tx
          .prepare(
            `INSERT INTO earn_external_wallet_withdrawal_request_transactions (
             id, organization_id, project_id, environment, provider, position_id,
             withdrawal_request_id, action, owner_address, vault_address, token_mint,
             share_mint, request_address, shares, quoted_assets, share_decimals,
             asset_decimals, discount_bps, maturity_timestamp, deadline_timestamp,
             fee_payer, unsigned_transaction, last_valid_block_height,
             created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING *`
          )
          .bind(
            input.id,
            input.organizationId,
            input.projectId,
            input.environment,
            input.provider,
            input.positionId ?? null,
            input.withdrawalRequestId ?? null,
            input.action,
            input.ownerAddress,
            input.vaultAddress,
            input.tokenMint,
            input.shareMint,
            input.requestAddress,
            input.shares ?? null,
            input.quotedAssets ?? null,
            input.shareDecimals ?? null,
            input.assetDecimals ?? null,
            input.discountBps ?? null,
            input.maturityTimestamp ?? null,
            input.deadlineTimestamp ?? null,
            input.feePayer ?? null,
            input.unsignedTransaction,
            input.lastValidBlockHeight,
            input.createdBy ?? null,
            input.initiatedByKeyId ?? null
          )
          .first<Record<string, unknown>>();
        if (row) return mapExternalBuild(row);
        throw conflict("Queued external-wallet transaction id or provider nonce is already in use");
      });
    },

    async getExternalWalletTransaction(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_external_wallet_withdrawal_request_transactions
            WHERE id = ? AND organization_id = ?`
        )
        .bind(params.transactionId, params.organizationId)
        .first<Record<string, unknown>>();
      return row ? mapExternalBuild(row) : null;
    },
  };
}
