import type { ReviewMode } from "./workflows";

export const KYC_STATUSES = ["unverified", "pending", "verified", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** Open string on purpose: providers are pluggable and validated app-side. */
export type KycProvider = string;

/**
 * A wallet whose holder identity has been verified once and reused across
 * assets. SDP owns the normalized kycStatus — provider writes are never the
 * source of truth.
 */
export interface KycWallet {
  id: string;
  organizationId: string;
  projectId: string;
  walletAddress: string;
  network: string;
  counterpartyId: string | null;
  kycStatus: KycStatus;
  kycProvider: KycProvider | null;
  providerRef: string | null;
  verifiedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const WALLET_ENROLLMENT_STATUSES = ["active", "revoked"] as const;
export type WalletEnrollmentStatus = (typeof WALLET_ENROLLMENT_STATUSES)[number];

/** A verified wallet cleared to hold a specific asset; an active row IS the clearance. */
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
