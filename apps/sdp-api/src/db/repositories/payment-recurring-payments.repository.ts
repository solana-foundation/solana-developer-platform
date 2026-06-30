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
export type PaymentRecurringPaymentUpdateAttemptMode = "metadata_schedule" | "replacement";
export type PaymentRecurringPaymentUpdateAttemptStatus = "processing" | "confirmed" | "failed";
export type PaymentRecurringPaymentUpdateAttemptStage =
  | "claim"
  | "update_plan"
  | "create_plan"
  | "authorize_subscription"
  | "cancel_old_subscription"
  | "finalize";

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

export interface PaymentRecurringPaymentUpdateAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  status: PaymentRecurringPaymentUpdateAttemptStatus;
  stage: PaymentRecurringPaymentUpdateAttemptStage;
  old_plan_id: string | null;
  old_subscription_id: string | null;
  new_plan_id: string | null;
  new_subscription_id: string | null;
  plan_update_signature: string | null;
  plan_creation_signature: string | null;
  authorization_setup_signature: string | null;
  authorization_signature: string | null;
  old_cancel_signature: string | null;
  changed_fields: string[];
  before_values: Record<string, unknown>;
  after_values: Record<string, unknown>;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRecurringPaymentUpdateEventRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  attempt_id: string | null;
  changed_fields: string[];
  before_values: Record<string, unknown>;
  after_values: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
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

export interface UpdatePaymentRecurringPaymentInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  sourceWalletId?: string;
  sourceAddress?: string;
  counterpartyId?: string;
  counterpartyAccountId?: string;
  destinationAddress?: string;
  destinationTokenAccount?: string | null;
  token?: string;
  amount?: string;
  periodHours?: number;
  firstCollectionAt?: string | null;
  nextCollectionDueAt?: string | null;
  planId?: string | null;
  subscriptionId?: string | null;
  planPda?: string | null;
  planCreatedAt?: string | null;
  planCreationSignature?: string | null;
  subscriptionPda?: string | null;
  subscriptionAuthorityAddress?: string | null;
  authorizationSignature?: string | null;
  status?: PaymentRecurringPaymentStatus;
  metadataUri?: string | null;
  expectedStatus?: PaymentRecurringPaymentStatus;
  expectedUpdatedAt?: string;
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

export interface ClaimPaymentRecurringPaymentUpdateInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
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

export interface CreatePaymentRecurringPaymentUpdateAttemptInput {
  id: string;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  status: PaymentRecurringPaymentUpdateAttemptStatus;
  stage: PaymentRecurringPaymentUpdateAttemptStage;
  oldPlanId: string | null;
  oldSubscriptionId: string | null;
  newPlanId: string | null;
  newSubscriptionId: string | null;
  planUpdateSignature: string | null;
  planCreationSignature: string | null;
  authorizationSetupSignature: string | null;
  authorizationSignature: string | null;
  oldCancelSignature: string | null;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentRecurringPaymentUpdateAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentUpdateAttemptStatus;
  stage?: PaymentRecurringPaymentUpdateAttemptStage;
  newPlanId?: string | null;
  newSubscriptionId?: string | null;
  planUpdateSignature?: string | null;
  planCreationSignature?: string | null;
  authorizationSetupSignature?: string | null;
  authorizationSignature?: string | null;
  oldCancelSignature?: string | null;
  changedFields?: string[];
  beforeValues?: Record<string, unknown>;
  afterValues?: Record<string, unknown>;
  error?: string | null;
  updatedAt: string;
}

export interface GetLatestPaymentRecurringPaymentUpdateAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  statuses?: PaymentRecurringPaymentUpdateAttemptStatus[];
}

export interface CreatePaymentRecurringPaymentUpdateEventInput {
  id: string;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string | null;
  changedFields: string[];
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
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

export interface GetLatestPaymentRecurringPaymentActivationAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  statuses?: PaymentRecurringPaymentActivationAttemptStatus[];
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
  updateRecurringPayment(
    input: UpdatePaymentRecurringPaymentInput
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
  claimRecurringPaymentUpdate(
    input: ClaimPaymentRecurringPaymentUpdateInput
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
  getLatestActivationAttempt(
    input: GetLatestPaymentRecurringPaymentActivationAttemptInput
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
  createUpdateAttempt(
    input: CreatePaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  updateUpdateAttempt(
    input: UpdatePaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow>;
  getLatestUpdateAttempt(
    input: GetLatestPaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  createUpdateEvent(
    input: CreatePaymentRecurringPaymentUpdateEventInput
  ): Promise<PaymentRecurringPaymentUpdateEventRow | null>;
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
