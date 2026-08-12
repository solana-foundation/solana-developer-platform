import type { KycProvider, KycStatus } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateKycWalletId(): string {
  return `kyc_wallet_${crypto.randomUUID()}`;
}

export interface KycWalletRow {
  id: string;
  organization_id: string;
  project_id: string;
  wallet_address: string;
  network: string;
  counterparty_id: string | null;
  kyc_status: KycStatus;
  kyc_provider: KycProvider | null;
  provider_ref: string | null;
  verified_at: string | null;
  // Moves only when kyc_status changes, so it identifies the transition rather than the
  // last write of any kind. Workflow idempotency keys off it.
  status_changed_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertKycWalletInput {
  organizationId: string;
  projectId: string;
  walletAddress: string;
  network?: string;
  counterpartyId?: string | null;
  createdBy?: string | null;
}

// Update the SDP-owned KYC status. `provider`/`providerRef` only record who verified it.
export interface SetKycStatusInput {
  kycWalletId: string;
  organizationId: string;
  projectId: string;
  status: KycStatus;
  provider?: KycProvider | null;
  providerRef?: string | null;
}

export interface SetKycStatusByCounterpartyInput {
  counterpartyId: string;
  // The counterparty's own scope — a defence-in-depth predicate on the webhook-driven
  // mutation path (counterparty ids arrive via provider-supplied identity).
  organizationId: string;
  projectId: string;
  status: KycStatus;
  provider?: KycProvider | null;
  providerRef?: string | null;
}

export interface KycWalletsRepositoryContext {
  db: RepositoryDbClient;
}

export interface KycWalletsRepository {
  // Insert-or-fetch the wallet identity row; sets/keeps the counterparty link.
  upsertKycWallet(input: UpsertKycWalletInput): Promise<KycWalletRow | null>;
  getKycWalletById(params: {
    kycWalletId: string;
    organizationId: string;
    projectId: string;
  }): Promise<KycWalletRow | null>;
  getKycWalletByAddress(params: {
    organizationId: string;
    projectId: string;
    walletAddress: string;
  }): Promise<KycWalletRow | null>;
  // Provider webhooks resolve which wallets to verify through the counterparty link.
  listKycWalletsByCounterparty(params: {
    counterpartyId: string;
    organizationId: string;
    projectId: string;
  }): Promise<KycWalletRow[]>;
  setKycStatus(input: SetKycStatusInput): Promise<KycWalletRow | null>;
  // Person-level verification: mark every wallet linked to a counterparty. Returns affected rows.
  setKycStatusByCounterparty(input: SetKycStatusByCounterpartyInput): Promise<KycWalletRow[]>;
}
