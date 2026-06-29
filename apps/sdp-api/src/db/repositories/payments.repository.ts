import type { PaymentTransferStatus } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { RepositoryDbClient } from "./base";

export type PaymentTransferDirection = "inbound" | "outbound";
export type PaymentTransferType =
  | "transfer"
  | "transfer_confidential"
  | "transfer_batch"
  | "onramp"
  | "offramp";
export const WALLET_TRANSFER_TYPES = [
  "transfer",
  "transfer_confidential",
  "transfer_batch",
] as const satisfies readonly PaymentTransferType[];
export const RAMP_TRANSFER_TYPES = [
  "onramp",
  "offramp",
] as const satisfies readonly PaymentTransferType[];
export type RampTransferType = (typeof RAMP_TRANSFER_TYPES)[number];
export function isRampTransferType(type: PaymentTransferType): type is RampTransferType {
  return type === "onramp" || type === "offramp";
}
export type PaymentTransferDeliveryMode = "hosted" | "manual_instructions" | "session_widget";
export type { PaymentTransferStatus };
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
  counterparty_id: string | null;
  source_address: string | null;
  destination_address: string | null;
  token: string;
  amount: string | null;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  provider: RampProviderId | null;
  provider_reference: string | null;
  delivery_mode: PaymentTransferDeliveryMode | null;
  fiat_currency: string | null;
  fiat_amount: string | null;
  provider_data: Record<string, unknown>;
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

export function generatePaymentTransferId(): string {
  return `xfr_${crypto.randomUUID()}`;
}

export interface CreatePaymentTransferInput {
  organizationId: string;
  projectId: string | null;
  walletId: string;
  counterpartyId: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  token: string;
  amount: string | null;
  memo: string | null;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  status: PaymentTransferStatus;
  provider: RampProviderId | null;
  providerReference: string | null;
  deliveryMode: PaymentTransferDeliveryMode | null;
  fiatCurrency: string | null;
  fiatAmount: string | null;
  providerData: Record<string, unknown>;
  serializedTx: string | null;
  signature: string | null;
  slot: number | null;
  initiatedByKeyId: string | null;
}

export interface UpdatePaymentTransferInput {
  transferId: string;
  organizationId?: string;
  projectId?: string | null;
  status?: PaymentTransferStatus;
  signature?: string | null;
  serializedTx?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  fee?: number | null;
  amount?: string | null;
  fiatAmount?: string | null;
  providerReference?: string | null;
  deliveryMode?: PaymentTransferDeliveryMode | null;
  providerData?: Record<string, unknown>;
  error?: string | null;
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

export interface ListTransfersInput {
  organizationId: string;
  projectId: string | null;
  walletId?: string;
  walletIds?: string[];
  counterpartyId?: string;
  sourceAddress?: string;
  token?: string;
  direction?: PaymentTransferDirection;
  statuses?: PaymentTransferStatus[];
  types?: readonly PaymentTransferType[];
  createdAtFrom?: string;
  createdAtTo?: string;
  limit: number;
  offset: number;
}

export interface ListTransfersByStatusInput {
  statuses: PaymentTransferStatus[];
  types?: readonly PaymentTransferType[];
  hasSignature?: boolean;
  createdBefore?: string;
  updatedBefore?: string;
  limit: number;
  offset?: number;
}

export interface ListTransfersResult {
  rows: PaymentTransferRow[];
  total: number;
}

export type GetTransferByProviderReferenceInput = {
  provider: RampProviderId;
  providerReference: string;
} & (
  | {
      organizationId: string;
      projectId: string | null;
    }
  | {
      organizationId?: never;
      projectId?: never;
    }
);

export interface PaymentsRepositoryContext {
  db: RepositoryDbClient;
}

export interface PaymentsRepository {
  createTransfer(input: CreatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  updateTransfer(input: UpdatePaymentTransferInput): Promise<PaymentTransferRow | null>;
  /**
   * Atomically transitions a transfer's status only if it is currently one of
   * `fromStatuses`, scoped to org/project. Returns the updated row, or null when
   * no row matched (wrong owner, missing, or status changed concurrently).
   */
  updateTransferStatusGuarded(input: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
    fromStatuses: readonly PaymentTransferStatus[];
    toStatus: PaymentTransferStatus;
    updatedAt: string;
  }): Promise<PaymentTransferRow | null>;
  listTransfersByStatus(params: ListTransfersByStatusInput): Promise<PaymentTransferRow[]>;
  getTransferById(params: {
    transferId: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow | null>;
  getTransferBySignature(params: {
    signature: string;
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow | null>;
  getTransferByProviderReference(
    params: GetTransferByProviderReferenceInput
  ): Promise<PaymentTransferRow | null>;
  listTransfersBySignatures(params: {
    signatures: string[];
    organizationId: string;
    projectId: string | null;
  }): Promise<PaymentTransferRow[]>;
  listTransfers(params: ListTransfersInput): Promise<ListTransfersResult>;
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
