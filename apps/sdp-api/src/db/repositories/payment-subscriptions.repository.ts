import type {
  PaymentSubscriptionCollectionAttemptStatus,
  PaymentSubscriptionPlanStatus,
  PaymentSubscriptionStatus,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export interface PaymentSubscriptionPlanRow {
  id: string;
  organization_id: string;
  project_id: string;
  owner_wallet_id: string;
  owner_address: string;
  token: string;
  amount: string;
  period_hours: number;
  program_plan_id: string;
  plan_pda: string | null;
  destination_address: string | null;
  puller_wallet_id: string | null;
  puller_address: string | null;
  metadata_uri: string | null;
  status: PaymentSubscriptionPlanStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentSubscriptionRow {
  id: string;
  organization_id: string;
  project_id: string;
  plan_id: string;
  counterparty_id: string;
  subscriber_address: string;
  subscriber_token_account: string | null;
  subscription_pda: string | null;
  subscription_authority_address: string | null;
  authorization_signature: string | null;
  status: PaymentSubscriptionStatus;
  current_period_start_at: string | null;
  next_collection_due_at: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentSubscriptionCollectionAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  subscription_id: string;
  transfer_id: string | null;
  token: string;
  amount: string;
  due_at: string;
  attempted_at: string | null;
  status: PaymentSubscriptionCollectionAttemptStatus;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentSubscriptionPlanInput {
  id: string;
  organizationId: string;
  projectId: string;
  ownerWalletId: string;
  ownerAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  programPlanId: string;
  planPda: string | null;
  destinationAddress: string | null;
  pullerWalletId: string | null;
  pullerAddress: string | null;
  metadataUri: string | null;
  status: PaymentSubscriptionPlanStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentSubscriptionPlanInput {
  planId: string;
  organizationId: string;
  projectId: string;
  planPda?: string | null;
  destinationAddress?: string | null;
  pullerWalletId?: string | null;
  pullerAddress?: string | null;
  metadataUri?: string | null;
  status?: PaymentSubscriptionPlanStatus;
  updatedAt: string;
}

export interface ListPaymentSubscriptionPlansInput {
  organizationId: string;
  projectId: string;
  status?: PaymentSubscriptionPlanStatus;
  limit: number;
  offset: number;
}

export interface CreatePaymentSubscriptionInput {
  id: string;
  organizationId: string;
  projectId: string;
  planId: string;
  counterpartyId: string;
  subscriberAddress: string;
  subscriberTokenAccount: string | null;
  subscriptionPda: string | null;
  subscriptionAuthorityAddress: string | null;
  authorizationSignature: string | null;
  status: PaymentSubscriptionStatus;
  currentPeriodStartAt: string | null;
  nextCollectionDueAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentSubscriptionInput {
  subscriptionId: string;
  organizationId: string;
  projectId: string;
  subscriberTokenAccount?: string | null;
  subscriptionPda?: string | null;
  subscriptionAuthorityAddress?: string | null;
  authorizationSignature?: string | null;
  status?: PaymentSubscriptionStatus;
  currentPeriodStartAt?: string | null;
  nextCollectionDueAt?: string | null;
  cancelAt?: string | null;
  canceledAt?: string | null;
  updatedAt: string;
}

export interface ListPaymentSubscriptionsInput {
  organizationId: string;
  projectId: string;
  planId?: string;
  counterpartyId?: string;
  subscriberAddress?: string;
  status?: PaymentSubscriptionStatus;
  dueBefore?: string;
  limit: number;
  offset: number;
}

export interface CreatePaymentSubscriptionCollectionAttemptInput {
  id: string;
  organizationId: string;
  projectId: string;
  subscriptionId: string;
  transferId: string | null;
  token: string;
  amount: string;
  dueAt: string;
  attemptedAt: string | null;
  status: PaymentSubscriptionCollectionAttemptStatus;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentSubscriptionCollectionAttemptsInput {
  organizationId: string;
  projectId: string;
  subscriptionId: string;
  status?: PaymentSubscriptionCollectionAttemptStatus;
  limit: number;
  offset: number;
}

export interface ListPaymentSubscriptionPlansResult {
  rows: PaymentSubscriptionPlanRow[];
  total: number;
}

export interface ListPaymentSubscriptionsResult {
  rows: PaymentSubscriptionRow[];
  total: number;
}

export interface ListPaymentSubscriptionCollectionAttemptsResult {
  rows: PaymentSubscriptionCollectionAttemptRow[];
  total: number;
}

export interface PaymentSubscriptionsRepositoryContext {
  db: RepositoryDbClient;
}

export interface PaymentSubscriptionsRepository {
  createPlan(input: CreatePaymentSubscriptionPlanInput): Promise<PaymentSubscriptionPlanRow | null>;
  updatePlan(input: UpdatePaymentSubscriptionPlanInput): Promise<PaymentSubscriptionPlanRow | null>;
  getPlanById(params: {
    planId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentSubscriptionPlanRow | null>;
  listPlans(params: ListPaymentSubscriptionPlansInput): Promise<ListPaymentSubscriptionPlansResult>;
  createSubscription(input: CreatePaymentSubscriptionInput): Promise<PaymentSubscriptionRow | null>;
  updateSubscription(input: UpdatePaymentSubscriptionInput): Promise<PaymentSubscriptionRow | null>;
  getSubscriptionById(params: {
    subscriptionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentSubscriptionRow | null>;
  listSubscriptions(params: ListPaymentSubscriptionsInput): Promise<ListPaymentSubscriptionsResult>;
  createCollectionAttempt(
    input: CreatePaymentSubscriptionCollectionAttemptInput
  ): Promise<PaymentSubscriptionCollectionAttemptRow | null>;
  listCollectionAttempts(
    params: ListPaymentSubscriptionCollectionAttemptsInput
  ): Promise<ListPaymentSubscriptionCollectionAttemptsResult>;
}
