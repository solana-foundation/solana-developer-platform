import type { PaymentRecurringPaymentStatus } from "@sdp/types";

export interface PaymentRecurringPaymentRow {
  id: string;
  organization_id: string;
  project_id: string;
  source_wallet_id: string;
  source_address: string;
  counterparty_id: string;
  counterparty_account_id: string;
  destination_address: string;
  destination_token_account: string | null;
  token: string;
  amount: string;
  period_hours: number;
  first_collection_at: string | null;
  next_collection_due_at: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  plan_pda: string | null;
  plan_created_at: string | null;
  plan_creation_signature: string | null;
  subscription_pda: string | null;
  subscription_authority_address: string | null;
  authorization_signature: string | null;
  status: PaymentRecurringPaymentStatus;
  metadata_uri: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type PaymentRecurringPaymentActivationAttemptStatus = "processing" | "confirmed" | "failed";
export type PaymentRecurringPaymentActivationAttemptStage =
  | "claim"
  | "create_plan"
  | "authorize_subscription"
  | "finalize";
export type PaymentRecurringPaymentLifecycleOperation = "cancel" | "resume";
export type PaymentRecurringPaymentLifecycleAttemptStatus = "processing" | "confirmed" | "failed";
export type PaymentRecurringPaymentLifecycleAttemptStage = "claim" | "submit" | "finalize";

export interface PaymentRecurringPaymentActivationAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  status: PaymentRecurringPaymentActivationAttemptStatus;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  plan_creation_signature: string | null;
  authorization_signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PaymentRecurringPaymentLifecycleAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  status: PaymentRecurringPaymentLifecycleAttemptStatus;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentRecurringPaymentInput {
  id: string;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  sourceAddress: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  metadataUri: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentActivationInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentStatus;
  planId?: string | null;
  subscriptionId?: string | null;
  planPda?: string | null;
  planCreatedAt?: string | null;
  planCreationSignature?: string | null;
  subscriptionPda?: string | null;
  subscriptionAuthorityAddress?: string | null;
  authorizationSignature?: string | null;
  nextCollectionDueAt?: string | null;
  destinationTokenAccount?: string | null;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentCollectionInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  currentCollectionDueAt: string;
  nextCollectionDueAt: string;
  destinationTokenAccount?: string | null;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentDestinationTokenAccountInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  destinationTokenAccount: string | null;
  updatedAt: string;
}

export interface ClaimPaymentRecurringPaymentLifecycleInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  updatedAt: string;
  staleBefore?: string;
}

export interface UpdatePaymentRecurringPaymentLifecycleInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  status: PaymentRecurringPaymentStatus;
  expectedStatus: PaymentRecurringPaymentStatus;
  updatedAt: string;
}

export interface CreatePaymentRecurringPaymentActivationAttemptInput {
  id: string;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  status: PaymentRecurringPaymentActivationAttemptStatus;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  planCreationSignature: string | null;
  authorizationSignature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentActivationAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentActivationAttemptStatus;
  stage?: PaymentRecurringPaymentActivationAttemptStage;
  planCreationSignature?: string | null;
  authorizationSignature?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface CreatePaymentRecurringPaymentLifecycleAttemptInput {
  id: string;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  status: PaymentRecurringPaymentLifecycleAttemptStatus;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentLifecycleAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentLifecycleAttemptStatus;
  stage?: PaymentRecurringPaymentLifecycleAttemptStage;
  signature?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface GetLatestPaymentRecurringPaymentLifecycleAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  statuses?: PaymentRecurringPaymentLifecycleAttemptStatus[];
}

export interface ListPaymentRecurringPaymentsInput {
  organizationId: string;
  projectId: string;
  sourceWalletIds?: string[];
  status?: PaymentRecurringPaymentStatus;
  counterpartyId?: string;
  limit: number;
  offset: number;
}

export interface ListPaymentRecurringPaymentsResult {
  rows: PaymentRecurringPaymentRow[];
  total: number;
}

export interface PaymentRecurringPaymentsRepository {
  createRecurringPayment(
    input: CreatePaymentRecurringPaymentInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  claimRecurringPaymentActivation(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    updatedAt: string;
    staleBefore?: string;
  }): Promise<PaymentRecurringPaymentRow | null>;
  resetRecurringPaymentActivationIfNotActive(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    updatedAt: string;
  }): Promise<PaymentRecurringPaymentRow | null>;
  updateRecurringPaymentActivation(
    input: UpdatePaymentRecurringPaymentActivationInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  updateRecurringPaymentCollection(
    input: UpdatePaymentRecurringPaymentCollectionInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  updateRecurringPaymentDestinationTokenAccount(
    input: UpdatePaymentRecurringPaymentDestinationTokenAccountInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  claimRecurringPaymentLifecycle(
    input: ClaimPaymentRecurringPaymentLifecycleInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  updateRecurringPaymentLifecycle(
    input: UpdatePaymentRecurringPaymentLifecycleInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  createActivationAttempt(
    input: CreatePaymentRecurringPaymentActivationAttemptInput
  ): Promise<PaymentRecurringPaymentActivationAttemptRow | null>;
  updateActivationAttempt(
    input: UpdatePaymentRecurringPaymentActivationAttemptInput
  ): Promise<PaymentRecurringPaymentActivationAttemptRow | null>;
  createLifecycleAttempt(
    input: CreatePaymentRecurringPaymentLifecycleAttemptInput
  ): Promise<PaymentRecurringPaymentLifecycleAttemptRow | null>;
  updateLifecycleAttempt(
    input: UpdatePaymentRecurringPaymentLifecycleAttemptInput
  ): Promise<PaymentRecurringPaymentLifecycleAttemptRow | null>;
  getLatestLifecycleAttempt(
    input: GetLatestPaymentRecurringPaymentLifecycleAttemptInput
  ): Promise<PaymentRecurringPaymentLifecycleAttemptRow | null>;
  getRecurringPaymentById(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    sourceWalletIds?: string[];
  }): Promise<PaymentRecurringPaymentRow | null>;
  listRecurringPayments(
    params: ListPaymentRecurringPaymentsInput
  ): Promise<ListPaymentRecurringPaymentsResult>;
}
