import type { ReviewMode, WalletEnrollmentStatus } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateWalletAssetEnrollmentId(): string {
  return `wallet_asset_enrollment_${crypto.randomUUID()}`;
}

export interface WalletAssetEnrollmentRow {
  id: string;
  organization_id: string;
  project_id: string;
  kyc_wallet_id: string;
  token_id: string;
  status: WalletEnrollmentStatus;
  review_mode: ReviewMode;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface UpsertWalletAssetEnrollmentInput {
  organizationId: string;
  projectId: string;
  kycWalletId: string;
  tokenId: string;
  reviewMode?: ReviewMode;
  createdBy?: string | null;
}

// A verified wallet cleared for an asset, joined with the wallet's identity fields —
// what the clearance evaluator and allowlist reconciliation both consume.
export interface EnrolledWalletRow extends WalletAssetEnrollmentRow {
  wallet_address: string;
  kyc_status: string;
}

export interface WalletAssetEnrollmentsRepositoryContext {
  db: RepositoryDbClient;
}

export interface WalletAssetEnrollmentsRepository {
  // Create-or-reactivate the (wallet, token) clearance.
  upsertEnrollment(
    input: UpsertWalletAssetEnrollmentInput
  ): Promise<WalletAssetEnrollmentRow | null>;
  getEnrollmentById(params: {
    enrollmentId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WalletAssetEnrollmentRow | null>;
  getActiveEnrollment(params: {
    kycWalletId: string;
    tokenId: string;
  }): Promise<WalletAssetEnrollmentRow | null>;
  // All assets a wallet is cleared for — drives clearance fan-out on KYC approval.
  listActiveEnrollmentsForWallet(params: {
    kycWalletId: string;
  }): Promise<WalletAssetEnrollmentRow[]>;
  // Reverse lookup: verified wallets cleared for an asset (allowlist reconcile / holders view).
  listEnrolledWalletsForToken(params: {
    tokenId: string;
    organizationId: string;
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: EnrolledWalletRow[]; total: number }>;
  revokeEnrollment(params: {
    enrollmentId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WalletAssetEnrollmentRow | null>;
}
