import { compareDecimalAmounts } from "@sdp/payments/decimal";
import { isDecimalString } from "@sdp/solana/amount";
import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  ApplyBvnkOnrampPayinInput,
  BvnkOnrampTransferCandidateRow,
  BvnkOnrampTransfersRepository,
  ClaimBvnkOnrampPayinSimulationInput,
  ClaimBvnkOnrampPayoutInput,
  FailBvnkOnrampPayoutInput,
  FailBvnkOnrampPayoutUnclaimedInput,
  GetBvnkOnrampTransferByIdInput,
  GetBvnkOnrampTransferByPayinIdInput,
  LeaseBvnkOnrampPayoutRecoveryInput,
  ListBvnkPayoutCandidatesInput,
  MarkBvnkOnrampPayoutPolledInput,
  RecordBvnkOnrampPayoutIdInput,
  SettleBvnkOnrampPayoutInput,
} from "./bvnk-onramp-transfers.repository";
import { mapTransferRow } from "./payments.repository.postgres";

function mapOnrampTransferCandidateRow(
  row: OnrampTransferProjectionRow
): BvnkOnrampTransferCandidateRow {
  return {
    ...mapTransferRow(row),
    fundingWalletReference: row.funding_wallet_reference as string,
    environment: row.environment as BvnkOnrampTransferCandidateRow["environment"],
  };
}

const ONRAMP_KIND = "'onramp' AS kind";

type OnrampTransferProjectionRow = Record<string, unknown> & { kind: "onramp" };

const PAYOUT_CANDIDATE_FROM = `
FROM payment_transfers pt
JOIN counterparty_provider_accounts cpa
  ON cpa.organization_id = pt.organization_id
 AND cpa.project_id = pt.project_id
 AND cpa.counterparty_id = pt.counterparty_id
 AND cpa.provider = 'bvnk'
 AND cpa.kind = 'funding_wallet'
 AND cpa.status = 'active'
 AND cpa.fiat_currency = pt.fiat_currency
JOIN projects prj
  ON prj.id = pt.project_id
WHERE pt.provider = 'bvnk'
  AND pt.type = 'onramp'
  AND pt.status = 'settling'
  AND jsonb_exists(pt.provider_data->'bvnk','payin')`;

const UNCLAIMED_PAYOUT_CANDIDATES_SQL = `SELECT pt.*, ${ONRAMP_KIND}, cpa.external_account_reference AS funding_wallet_reference, prj.environment AS environment${PAYOUT_CANDIDATE_FROM}
  AND NOT jsonb_exists(pt.provider_data->'bvnk','payout')
ORDER BY pt.updated_at ASC
LIMIT ?`;

const RECOVERABLE_PAYOUT_CANDIDATES_SQL = `SELECT pt.*, ${ONRAMP_KIND}, cpa.external_account_reference AS funding_wallet_reference, prj.environment AS environment${PAYOUT_CANDIDATE_FROM}
  AND NOT jsonb_exists(pt.provider_data->'bvnk'->'payout','payoutId')
  AND pt.provider_data->'bvnk'->'payout'->>'claimedAt' < ?
ORDER BY pt.updated_at ASC
LIMIT ?`;

const POLLABLE_PAYOUT_CANDIDATES_SQL = `SELECT pt.*, ${ONRAMP_KIND}, cpa.external_account_reference AS funding_wallet_reference, prj.environment AS environment${PAYOUT_CANDIDATE_FROM}
  AND jsonb_exists(pt.provider_data->'bvnk'->'payout','payoutId')
  AND coalesce(pt.provider_data->'bvnk'->'payout'->>'lastPolledAt', pt.provider_data->'bvnk'->'payout'->>'claimedAt') < ?
ORDER BY pt.updated_at ASC
LIMIT ?`;

const GET_BY_PAYIN_ID_SQL = `SELECT pt.*, ${ONRAMP_KIND}
FROM payment_transfers pt
JOIN projects prj
  ON prj.id = pt.project_id
WHERE pt.provider = 'bvnk'
  AND pt.type = 'onramp'
  AND pt.provider_data->'bvnk'->'payin'->>'id' = ?
  AND prj.environment = ?`;

const GET_BY_ID_SQL = `SELECT pt.*, ${ONRAMP_KIND}
FROM payment_transfers pt
JOIN projects prj
  ON prj.id = pt.project_id
WHERE pt.id = ?
  AND pt.provider = 'bvnk'
  AND pt.type = 'onramp'
  AND prj.environment = ?`;

const APPLY_PAYIN_SQL = `UPDATE payment_transfers pt
SET status = 'settling',
    fiat_amount = ?,
    fiat_currency = ?,
    provider_data = jsonb_set(provider_data, '{bvnk,payin}', ?::jsonb),
    updated_at = sdp_iso_now()
WHERE pt.id = ?
  AND pt.provider = 'bvnk'
  AND pt.type = 'onramp'
  AND pt.status = 'awaiting_payment'
  AND NOT jsonb_exists(provider_data->'bvnk','payin')
  AND fiat_currency = ?
  AND EXISTS (
    SELECT 1
    FROM counterparty_provider_accounts cpa
    WHERE cpa.organization_id = pt.organization_id
      AND cpa.project_id = pt.project_id
      AND cpa.counterparty_id = pt.counterparty_id
      AND cpa.provider = 'bvnk'
      AND cpa.kind = 'funding_wallet'
      AND cpa.status = 'active'
      AND cpa.fiat_currency = pt.fiat_currency
      AND cpa.external_account_reference = ?
  )
RETURNING pt.*, ${ONRAMP_KIND}`;

const CLAIM_PAYOUT_SQL = `UPDATE payment_transfers
SET provider_data = jsonb_set(provider_data, '{bvnk,payout}', ?::jsonb),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND jsonb_exists(provider_data->'bvnk','payin')
  AND NOT jsonb_exists(provider_data->'bvnk','payout')
RETURNING *, ${ONRAMP_KIND}`;

const LEASE_PAYOUT_RECOVERY_SQL = `UPDATE payment_transfers
SET provider_data = jsonb_set(
      jsonb_set(provider_data, '{bvnk,payout,claimedAt}', to_jsonb(?::text)),
      '{bvnk,payout,attempts}',
      to_jsonb((provider_data->'bvnk'->'payout'->>'attempts')::int + 1)
    ),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND provider_data->'bvnk'->'payout'->>'claimedAt' = ?
  AND NOT jsonb_exists(provider_data->'bvnk'->'payout','payoutId')
RETURNING *, ${ONRAMP_KIND}`;

const RECORD_PAYOUT_ID_SQL = `UPDATE payment_transfers
SET provider_data = jsonb_set(
      jsonb_set(provider_data, '{bvnk,payout,payoutId}', to_jsonb(?::text)),
      '{settlement}',
      ?::jsonb
    ),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND NOT jsonb_exists(provider_data->'bvnk'->'payout','payoutId')
  AND NOT jsonb_exists(provider_data,'settlement')
  AND provider_data->'bvnk'->'payout'->>'claimedAt' = ?
RETURNING *, ${ONRAMP_KIND}`;

const SETTLE_PAYOUT_SQL = `UPDATE payment_transfers
SET status = 'completed',
    signature = ?,
    destination_address = ?,
    amount = ?,
    provider_data = jsonb_set(provider_data, '{settlement}', ?::jsonb),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND provider_data->'bvnk'->'payout'->>'payoutId' = ?
  AND provider_data->'bvnk'->'payout'->>'claimedAt' = ?
RETURNING *, ${ONRAMP_KIND}`;

const FAIL_PAYOUT_FIRST_ATTEMPT_SQL = `UPDATE payment_transfers
SET status = 'failed',
    error = ?,
    provider_data = jsonb_set(provider_data, '{bvnk,payout,lastError}', to_jsonb(?::text)),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND NOT jsonb_exists(provider_data->'bvnk'->'payout','payoutId')
  AND provider_data->'bvnk'->'payout'->>'attempts' = '1'
  AND provider_data->'bvnk'->'payout'->>'claimedAt' = ?
RETURNING *, ${ONRAMP_KIND}`;

const FAIL_PAYOUT_WITH_ID_SQL = `UPDATE payment_transfers
SET status = 'failed',
    error = ?,
    provider_data = jsonb_set(provider_data, '{bvnk,payout,lastError}', to_jsonb(?::text)),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND provider_data->'bvnk'->'payout'->>'payoutId' = ?
  AND provider_data->'bvnk'->'payout'->>'claimedAt' = ?
RETURNING *, ${ONRAMP_KIND}`;

const FAIL_PAYOUT_UNCLAIMED_SQL = `UPDATE payment_transfers
SET status = 'failed',
    error = ?,
    provider_data = jsonb_set(provider_data, '{bvnk,payout}', ?::jsonb),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND NOT jsonb_exists(provider_data->'bvnk','payout')
RETURNING *, ${ONRAMP_KIND}`;

const MARK_PAYOUT_POLLED_SQL = `UPDATE payment_transfers
SET provider_data = jsonb_set(provider_data, '{bvnk,payout,lastPolledAt}', to_jsonb(?::text)),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'settling'
  AND jsonb_exists(provider_data->'bvnk'->'payout','payoutId')
RETURNING *, ${ONRAMP_KIND}`;

const CLAIM_PAYIN_SIMULATION_SQL = `UPDATE payment_transfers
SET provider_data = jsonb_set(provider_data, '{bvnk,simulation}', ?::jsonb),
    updated_at = sdp_iso_now()
WHERE id = ?
  AND provider = 'bvnk'
  AND type = 'onramp'
  AND status = 'awaiting_payment'
  AND NOT jsonb_exists(provider_data->'bvnk','simulation')
RETURNING *, ${ONRAMP_KIND}`;

function assertPositiveDecimalAmount(amount: string, label: string): string {
  const normalized = amount.trim();
  if (!isDecimalString(normalized) || compareDecimalAmounts(normalized, "0") <= 0) {
    throw internalError(`BVNK on-ramp pay-in ${label} must be a positive decimal amount.`);
  }
  return normalized;
}

export function createPostgresBvnkOnrampTransfersRepository(
  db: AppDb
): BvnkOnrampTransfersRepository {
  return {
    async getByPayinId(input: GetBvnkOnrampTransferByPayinIdInput) {
      const row = await db
        .prepare(GET_BY_PAYIN_ID_SQL)
        .bind(input.payinId, input.environment)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async getById(input: GetBvnkOnrampTransferByIdInput) {
      const row = await db
        .prepare(GET_BY_ID_SQL)
        .bind(input.transferId, input.environment)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async applyPayin(input: ApplyBvnkOnrampPayinInput) {
      const receivedAmount = assertPositiveDecimalAmount(
        input.payin.receivedAmount,
        "received amount"
      );
      const row = await db
        .prepare(APPLY_PAYIN_SQL)
        .bind(
          receivedAmount,
          input.payin.receivedCurrency,
          JSON.stringify(input.payin),
          input.transferId,
          input.payin.receivedCurrency,
          input.fundingWalletReference
        )
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async listUnclaimedPayoutCandidates(input: ListBvnkPayoutCandidatesInput) {
      const rows = await db
        .prepare(UNCLAIMED_PAYOUT_CANDIDATES_SQL)
        .bind(input.limit)
        .all<OnrampTransferProjectionRow>();

      return rows.results.map(mapOnrampTransferCandidateRow);
    },

    async listRecoverablePayoutCandidates(input: ListBvnkPayoutCandidatesInput) {
      const rows = await db
        .prepare(RECOVERABLE_PAYOUT_CANDIDATES_SQL)
        .bind(input.cutoff, input.limit)
        .all<OnrampTransferProjectionRow>();

      return rows.results.map(mapOnrampTransferCandidateRow);
    },

    async listPollablePayoutCandidates(input: ListBvnkPayoutCandidatesInput) {
      const rows = await db
        .prepare(POLLABLE_PAYOUT_CANDIDATES_SQL)
        .bind(input.cutoff, input.limit)
        .all<OnrampTransferProjectionRow>();

      return rows.results.map(mapOnrampTransferCandidateRow);
    },

    async claimPayout(input: ClaimBvnkOnrampPayoutInput) {
      const payout = {
        claimedAt: input.claimedAt,
        attempts: 1,
        intent: input.intent,
      };
      const row = await db
        .prepare(CLAIM_PAYOUT_SQL)
        .bind(JSON.stringify(payout), input.transferId)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async leasePayoutRecovery(input: LeaseBvnkOnrampPayoutRecoveryInput) {
      const row = await db
        .prepare(LEASE_PAYOUT_RECOVERY_SQL)
        .bind(input.claimedAt, input.transferId, input.observedClaimedAt)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async recordPayoutId(input: RecordBvnkOnrampPayoutIdInput) {
      const row = await db
        .prepare(RECORD_PAYOUT_ID_SQL)
        .bind(input.payoutId, JSON.stringify(input.settlement), input.transferId, input.claimedAt)
        .first<OnrampTransferProjectionRow>();

      if (row !== null) {
        return mapTransferRow(row);
      }

      const current = await this.getById({
        transferId: input.transferId,
        environment: input.environment,
      });
      if (current === null) {
        throw internalError(
          `BVNK on-ramp payout ${input.transferId} vanished while recording payout id ${input.payoutId}.`
        );
      }
      const payout = current.provider_data.bvnk as { payout?: Record<string, unknown> } | undefined;
      const storedPayoutId = payout?.payout?.payoutId;
      if (storedPayoutId === input.payoutId) {
        return current;
      }
      throw internalError(
        `BVNK on-ramp payout id diverged: stored ${String(storedPayoutId)} vs recorded ${input.payoutId}.`
      );
    },

    async settlePayout(input: SettleBvnkOnrampPayoutInput) {
      const row = await db
        .prepare(SETTLE_PAYOUT_SQL)
        .bind(
          input.update.signature,
          input.update.destinationAddress,
          input.update.amount,
          JSON.stringify(input.update.settlement),
          input.transferId,
          input.payoutId,
          input.claimedAt
        )
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async failPayout(input: FailBvnkOnrampPayoutInput) {
      const row =
        input.payoutId === null
          ? await db
              .prepare(FAIL_PAYOUT_FIRST_ATTEMPT_SQL)
              .bind(input.error, input.error, input.transferId, input.claimedAt)
              .first<OnrampTransferProjectionRow>()
          : await db
              .prepare(FAIL_PAYOUT_WITH_ID_SQL)
              .bind(input.error, input.error, input.transferId, input.payoutId, input.claimedAt)
              .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async failPayoutUnclaimed(input: FailBvnkOnrampPayoutUnclaimedInput) {
      const payout = {
        claimedAt: input.claimedAt,
        attempts: 1,
        lastError: input.error,
      };
      const row = await db
        .prepare(FAIL_PAYOUT_UNCLAIMED_SQL)
        .bind(input.error, JSON.stringify(payout), input.transferId)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async markPayoutPolled(input: MarkBvnkOnrampPayoutPolledInput) {
      const row = await db
        .prepare(MARK_PAYOUT_POLLED_SQL)
        .bind(input.polledAt, input.transferId)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },

    async claimPayinSimulation(input: ClaimBvnkOnrampPayinSimulationInput) {
      const row = await db
        .prepare(CLAIM_PAYIN_SIMULATION_SQL)
        .bind(JSON.stringify({ requestedAt: input.requestedAt }), input.transferId)
        .first<OnrampTransferProjectionRow>();

      return row === null ? null : mapTransferRow(row);
    },
  };
}
