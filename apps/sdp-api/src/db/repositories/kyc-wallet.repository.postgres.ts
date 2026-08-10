import type { KycProvider, KycStatus } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  generateKycWalletId,
  type KycWalletRow,
  type KycWalletsRepository,
  type SetKycStatusByCounterpartyInput,
  type SetKycStatusInput,
  type UpsertKycWalletInput,
} from "./kyc-wallet.repository";

function mapKycWalletRow(row: Record<string, unknown>): KycWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    wallet_address: row.wallet_address as string,
    network: row.network as string,
    counterparty_id: (row.counterparty_id as string | null) ?? null,
    kyc_status: row.kyc_status as KycStatus,
    kyc_provider: (row.kyc_provider as KycProvider | null) ?? null,
    provider_ref: (row.provider_ref as string | null) ?? null,
    verified_at: (row.verified_at as string | null) ?? null,
    status_changed_at: row.status_changed_at as string,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// verified_at is stamped only on the verified transition; cleared otherwise.
const VERIFIED_AT_EXPR = "CASE WHEN ? = 'verified' THEN sdp_iso_now() ELSE NULL END";

export function createPostgresKycWalletsRepository(db: AppDb): KycWalletsRepository {
  return {
    async upsertKycWallet(input: UpsertKycWalletInput) {
      const id = generateKycWalletId();
      // Insert fresh, or keep the existing row and only fill/refresh the counterparty link.
      await db
        .prepare(
          `INSERT INTO kyc_wallets (
             id, organization_id, project_id, wallet_address, network, counterparty_id, created_by
           ) VALUES (?, ?, ?, ?, COALESCE(?, 'solana'), ?, ?)
           ON CONFLICT (organization_id, project_id, wallet_address)
           DO UPDATE SET
             counterparty_id = COALESCE(EXCLUDED.counterparty_id, kyc_wallets.counterparty_id),
             updated_at = sdp_iso_now()`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.walletAddress,
          input.network ?? null,
          input.counterpartyId ?? null,
          input.createdBy ?? null
        )
        .run();

      return this.getKycWalletByAddress({
        organizationId: input.organizationId,
        projectId: input.projectId,
        walletAddress: input.walletAddress,
      });
    },

    async getKycWalletById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM kyc_wallets WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(params.kycWalletId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapKycWalletRow(row) : null;
    },

    async getKycWalletByAddress(params) {
      const row = await db
        .prepare(
          `SELECT * FROM kyc_wallets
             WHERE organization_id = ? AND project_id = ? AND wallet_address = ?`
        )
        .bind(params.organizationId, params.projectId, params.walletAddress)
        .first<Record<string, unknown>>();
      return row ? mapKycWalletRow(row) : null;
    },

    async listKycWalletsByCounterparty(params) {
      const result = await db
        .prepare(
          `SELECT * FROM kyc_wallets
             WHERE counterparty_id = ? AND organization_id = ? AND project_id = ?
             ORDER BY created_at ASC`
        )
        .bind(params.counterpartyId, params.organizationId, params.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapKycWalletRow);
    },

    async setKycStatus(input: SetKycStatusInput) {
      // `AND kyc_status IS DISTINCT FROM ?` makes a same-status write a no-op instead of
      // re-stamping the row. Workflow idempotency keys are derived from verified_at /
      // updated_at, so an unconditional write let a redelivered provider webhook mint a
      // fresh key and enqueue the same rule twice (see clearance.ts `transition`).
      await db
        .prepare(
          `UPDATE kyc_wallets
             SET kyc_status = ?,
                 kyc_provider = COALESCE(?, kyc_provider),
                 provider_ref = COALESCE(?, provider_ref),
                 verified_at = ${VERIFIED_AT_EXPR},
                 status_changed_at = sdp_iso_now(),
                 updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ?
             AND kyc_status IS DISTINCT FROM ?`
        )
        .bind(
          input.status,
          input.provider ?? null,
          input.providerRef ?? null,
          input.status,
          input.kycWalletId,
          input.organizationId,
          input.projectId,
          input.status
        )
        .run();
      // Re-read rather than treating "no rows updated" as missing: an unchanged status is
      // a successful no-op, and the read still yields null when the wallet truly is gone.
      return this.getKycWalletById({
        kycWalletId: input.kycWalletId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async setKycStatusByCounterparty(input: SetKycStatusByCounterpartyInput) {
      // Same idempotency guard as setKycStatus: this is the path a redelivered Mural
      // webhook takes, so a same-status write must leave the row's timestamps alone.
      await db
        .prepare(
          `UPDATE kyc_wallets
             SET kyc_status = ?,
                 kyc_provider = COALESCE(?, kyc_provider),
                 provider_ref = COALESCE(?, provider_ref),
                 verified_at = ${VERIFIED_AT_EXPR},
                 status_changed_at = sdp_iso_now(),
                 updated_at = sdp_iso_now()
           WHERE counterparty_id = ? AND organization_id = ? AND project_id = ?
             AND kyc_status IS DISTINCT FROM ?`
        )
        .bind(
          input.status,
          input.provider ?? null,
          input.providerRef ?? null,
          input.status,
          input.counterpartyId,
          input.organizationId,
          input.projectId,
          input.status
        )
        .run();
      return this.listKycWalletsByCounterparty({
        counterpartyId: input.counterpartyId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },
  };
}
