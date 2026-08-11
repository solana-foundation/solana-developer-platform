import type { ReviewMode } from "./workflows";

export const KYC_STATUSES = ["unverified", "pending", "verified", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** Open string on purpose: providers are pluggable and validated app-side. */
export type KycProvider = string;

/**
 * A wallet whose holder identity has been verified once and reused across
 * assets — the SDP-owned, provider-agnostic holder-verification layer that
 * feeds workflow triggers. A wallet is "cleared" to hold a specific asset via
 * an active enrollment, see {@link WalletAssetEnrollment}.
 */
export interface KycWallet {
  id: string;
  organizationId: string;
  projectId: string;
  walletAddress: string;
  network: string;
  /**
   * Optional link to the person/business whose identity this wallet belongs
   * to. Set at enroll time; used by provider webhooks to resolve which
   * wallets to verify.
   */
  counterpartyId: string | null;
  kycStatus: KycStatus;
  /**
   * Who verified it and their external handle. KYC providers (Mural today,
   * others later) only write into kycStatus — SDP owns the normalized
   * status, so this field is never the source of truth for status.
   */
  kycProvider: KycProvider | null;
  providerRef: string | null;
  verifiedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const WALLET_ENROLLMENT_STATUSES = ["active", "revoked"] as const;
export type WalletEnrollmentStatus = (typeof WALLET_ENROLLMENT_STATUSES)[number];

/**
 * A verified wallet cleared to hold a specific asset (keyed on token — the
 * stable identity). In v1 the existence of an active row IS the eligibility
 * clearance.
 */
export interface WalletAssetEnrollment {
  id: string;
  organizationId: string;
  projectId: string;
  kycWalletId: string;
  tokenId: string;
  status: WalletEnrollmentStatus;
  reviewMode: ReviewMode;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
}
