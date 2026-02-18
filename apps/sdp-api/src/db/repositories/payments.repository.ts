import type { DrizzleDbClient } from "./base";

export type PaymentTransferDirection = "inbound" | "outbound";
export type PaymentTransferType = "transfer" | "transfer_confidential";
export type PaymentTransferStatus = "pending" | "processing" | "confirmed" | "finalized" | "failed";
export type PaymentWalletPolicyType = string;

export interface PaymentWalletPolicyRow {
  id: string;
  custody_wallet_id: string;
  policy_type: PaymentWalletPolicyType;
  policy: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentTransferRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  wallet_id: string;
  source_address: string;
  destination_address: string;
  token: string;
  amount: string;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  signature: string | null;
  serialized_tx: string | null;
  slot: number | null;
  block_time: string | null;
  fee: number | null;
  error: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentTransferInput {
  id: string;
  organizationId: string;
  projectId: string | null;
  walletId: string;
  sourceAddress: string;
  destinationAddress: string;
  token: string;
  amount: string;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  serializedTx: string | null;
  initiatedByKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPaymentWalletPolicyInput {
  id: string;
  custodyWalletId: string;
  policyType: PaymentWalletPolicyType;
  policy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentsRepositoryContext {
  db: DrizzleDbClient;
}

export interface PaymentsRepository {
  createTransfer(input: CreatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  getTransferById(params: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow | null>;
  listTransferAmounts(params: {
    organizationId: string;
    projectId: string | null;
    walletId: string;
    token: string;
    direction: PaymentTransferDirection;
    statuses: PaymentTransferStatus[];
    createdAtFrom: string;
    createdAtTo: string;
  }): Promise<string[]>;
  getWalletPoliciesByCustodyWalletId(custodyWalletId: string): Promise<PaymentWalletPolicyRow[]>;
  upsertWalletPolicies(input: UpsertPaymentWalletPolicyInput[]): Promise<PaymentWalletPolicyRow[]>;
}
