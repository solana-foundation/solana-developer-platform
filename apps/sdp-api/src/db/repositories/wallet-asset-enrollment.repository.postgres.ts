import type { ReviewMode, WalletEnrollmentStatus } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type EnrolledWalletRow,
  generateWalletAssetEnrollmentId,
  type UpsertWalletAssetEnrollmentInput,
  type WalletAssetEnrollmentRow,
  type WalletAssetEnrollmentsRepository,
} from "./wallet-asset-enrollment.repository";

function mapEnrollmentRow(row: Record<string, unknown>): WalletAssetEnrollmentRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    kyc_wallet_id: row.kyc_wallet_id as string,
    token_id: row.token_id as string,
    status: row.status as WalletEnrollmentStatus,
    review_mode: row.review_mode as ReviewMode,
    created_by: (row.created_by as string | null) ?? null,
    created_at: row.created_at as string,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}

function mapEnrolledWalletRow(row: Record<string, unknown>): EnrolledWalletRow {
  return {
    ...mapEnrollmentRow(row),
    wallet_address: row.wallet_address as string,
    kyc_status: row.kyc_status as string,
  };
}

export function createPostgresWalletAssetEnrollmentsRepository(
  db: AppDb
): WalletAssetEnrollmentsRepository {
  return {
    async upsertEnrollment(input: UpsertWalletAssetEnrollmentInput) {
      const id = generateWalletAssetEnrollmentId();
      await db
        .prepare(
          `INSERT INTO wallet_asset_enrollments (
             id, organization_id, project_id, kyc_wallet_id, token_id, review_mode, created_by
           ) VALUES (?, ?, ?, ?, ?, COALESCE(?, 'auto'), ?)
           ON CONFLICT (kyc_wallet_id, token_id)
           DO UPDATE SET
             status = 'active',
             revoked_at = NULL,
             review_mode = COALESCE(EXCLUDED.review_mode, wallet_asset_enrollments.review_mode)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.kycWalletId,
          input.tokenId,
          input.reviewMode ?? null,
          input.createdBy ?? null
        )
        .run();

      return this.getActiveEnrollment({ kycWalletId: input.kycWalletId, tokenId: input.tokenId });
    },

    async getEnrollmentById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM wallet_asset_enrollments
             WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(params.enrollmentId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapEnrollmentRow(row) : null;
    },

    async getActiveEnrollment(params) {
      const row = await db
        .prepare(
          `SELECT * FROM wallet_asset_enrollments
             WHERE kyc_wallet_id = ? AND token_id = ? AND status = 'active'`
        )
        .bind(params.kycWalletId, params.tokenId)
        .first<Record<string, unknown>>();
      return row ? mapEnrollmentRow(row) : null;
    },

    async listActiveEnrollmentsForWallet(params) {
      const result = await db
        .prepare(
          `SELECT * FROM wallet_asset_enrollments
             WHERE kyc_wallet_id = ? AND status = 'active'
             ORDER BY created_at ASC`
        )
        .bind(params.kycWalletId)
        .all<Record<string, unknown>>();
      return result.results.map(mapEnrollmentRow);
    },

    async listEnrolledWalletsForToken(params) {
      const rowsResult = await db
        .prepare(
          `SELECT e.*, w.wallet_address, w.kyc_status
             FROM wallet_asset_enrollments e
             JOIN kyc_wallets w ON w.id = e.kyc_wallet_id
            WHERE e.token_id = ? AND e.organization_id = ? AND e.project_id = ? AND e.status = 'active'
            ORDER BY e.created_at DESC
            LIMIT ? OFFSET ?`
        )
        .bind(params.tokenId, params.organizationId, params.projectId, params.limit, params.offset)
        .all<Record<string, unknown>>();

      const totalRow = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM wallet_asset_enrollments
             WHERE token_id = ? AND organization_id = ? AND project_id = ? AND status = 'active'`
        )
        .bind(params.tokenId, params.organizationId, params.projectId)
        .first<{ total: number }>();

      return {
        rows: rowsResult.results.map(mapEnrolledWalletRow),
        total: totalRow?.total ?? 0,
      };
    },

    async revokeEnrollment(params) {
      const rowsAffected = await db
        .prepare(
          `UPDATE wallet_asset_enrollments
             SET status = 'revoked', revoked_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'`
        )
        .bind(params.enrollmentId, params.organizationId, params.projectId)
        .run();
      if (rowsAffected === 0) {
        return null;
      }
      return this.getEnrollmentById({
        enrollmentId: params.enrollmentId,
        organizationId: params.organizationId,
        projectId: params.projectId,
      });
    },
  };
}
