import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  PaymentRecurringPaymentActivationAttemptStage,
  PaymentRecurringPaymentAttemptStatus,
  PaymentRecurringPaymentLifecycleAttemptStage,
  PaymentRecurringPaymentLifecycleOperation,
  PaymentRecurringPaymentStatus,
  PaymentRecurringPaymentUpdateAttemptMode,
  PaymentRecurringPaymentUpdateAttemptStage,
  RecurringPaymentStatusWithRecoverableCollection,
} from "@sdp/types/payments";

export interface PaymentRecurringPaymentRow {
  id: string;
  organization_id: string;
  project_id: string;
  source_custody_wallet_id: string | null;
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

export interface RecurringPaymentCollectionCycleRow extends PaymentRecurringPaymentRow {
  subscription_id: string;
  next_collection_due_at: string;
}

export interface CollectibleRecurringPaymentRow extends RecurringPaymentCollectionCycleRow {
  status: "active";
}

export interface RecoverableCollectionRecurringPaymentRow
  extends RecurringPaymentCollectionCycleRow {
  status: RecurringPaymentStatusWithRecoverableCollection;
}

export interface PaymentRecurringPaymentActivationAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  plan_creation_signature: string | null;
  authorization_signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** The Idempotency-Key of the request that claimed this attempt (HOO-1918), or null. */
  idempotency_key: string | null;
}

export interface PaymentRecurringPaymentLifecycleAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** The Idempotency-Key of the request that claimed this attempt (HOO-1918), or null. */
  idempotency_key: string | null;
}

export interface PaymentRecurringPaymentUpdateAttemptRow {
  id: string;
  organization_id: string;
  project_id: string;
  recurring_payment_id: string;
  mode: PaymentRecurringPaymentUpdateAttemptMode;
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentUpdateAttemptStage;
  old_plan_id: string | null;
  old_subscription_id: string | null;
  new_plan_id: string | null;
  new_subscription_id: string | null;
  new_source_custody_wallet_id: string | null;
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
  /** The Idempotency-Key of the request that claimed this attempt (HOO-1918), or null. */
  idempotency_key: string | null;
  /** The fingerprint of that request's validated body: the same key with other terms is a 422. */
  idempotency_fingerprint: string | null;
  /**
   * The activator this attempt's claim replaced, restored if the attempt is
   * abandoned; null when the claim changed no activator (HOO-2099).
   */
  previous_activator: StoredRecurringPaymentActivator | null;
}

/** An activator as stored: both null for a payment no principal activated. */
export interface StoredRecurringPaymentActivator {
  apiKeyId: string | null;
  userId: string | null;
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
  sourceCustodyWalletId: string;
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
  /** The request's Idempotency-Key and its fingerprint (HOO-1918), or null. */
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
}

export interface UpdatePaymentRecurringPaymentInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  sourceCustodyWalletId?: string;
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

/**
 * Who activated or resumed a recurring payment, recorded on the claim for
 * audit and for "revoke this key and cancel what it activated" (APE-343).
 * Null keeps the stored value: the job's recovery and a cancel record nobody.
 */
export type RecurringPaymentActivator =
  | { apiKeyId: string; userId: null }
  | { apiKeyId: null; userId: string };

export interface ClaimPaymentRecurringPaymentLifecycleInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  updatedAt: string;
  staleBefore?: string;
  activatedBy: RecurringPaymentActivator | null;
}

export interface ClaimPaymentRecurringPaymentUpdateInput {
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  updatedAt: string;
  staleBefore?: string;
  /**
   * Who the mandate answers to after an update that changes where or how much
   * money moves; null keeps the stored activator (HOO-2099).
   */
  activatedBy: RecurringPaymentActivator | null;
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
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentUpdateAttemptStage;
  oldPlanId: string | null;
  oldSubscriptionId: string | null;
  newPlanId: string | null;
  newSubscriptionId: string | null;
  newSourceCustodyWalletId: string | null;
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
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  /** The activator the claim replaced; null when it changed none. */
  previousActivator?: StoredRecurringPaymentActivator | null;
}

export interface UpdatePaymentRecurringPaymentUpdateAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentAttemptStatus;
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
  /**
   * A keyed request that adopts this attempt (a stale claim, a takeover)
   * records its Idempotency-Key on it when it has none (HOO-1918), so a retry
   * is answered from the attempt instead of running the action again.
   */
  adoptIdempotencyKey?: string | null;
  /** The adopting request's fingerprint, recorded only with its key. */
  adoptIdempotencyFingerprint?: string | null;
  updatedAt: string;
}

/**
 * Where one subscription step's saved signature lives. Activation's authority-setup signature is a
 * key in its attempt's `metadata`, not a column.
 */
export type RecurringPaymentStepSignatureSlot =
  | { row: "recurring_payment"; column: "plan_creation_signature" | "authorization_signature" }
  | {
      row: "activation_attempt";
      column:
        | "plan_creation_signature"
        | "authorization_signature"
        | "metadata.authorizationSetupSignature";
    }
  | {
      row: "update_attempt";
      column:
        | "plan_update_signature"
        | "plan_creation_signature"
        | "authorization_setup_signature"
        | "authorization_signature"
        | "old_cancel_signature";
    }
  | { row: "lifecycle_attempt"; column: "signature" };

export interface ClearPaymentRecurringPaymentStepSignatureInput {
  slot: RecurringPaymentStepSignatureSlot;
  /** The recurring payment's id for `recurring_payment`, otherwise the attempt's. */
  id: string;
  organizationId: string;
  projectId: string;
  /** The signature the step saved; the slot is cleared only while it still holds it. */
  signature: string;
  updatedAt: string;
}

export interface GetLatestPaymentRecurringPaymentUpdateAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  statuses?: readonly PaymentRecurringPaymentAttemptStatus[];
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
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  planCreationSignature: string | null;
  authorizationSignature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  idempotencyKey?: string | null;
}

export interface UpdatePaymentRecurringPaymentActivationAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentAttemptStatus;
  stage?: PaymentRecurringPaymentActivationAttemptStage;
  planCreationSignature?: string | null;
  authorizationSignature?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * A keyed request that adopts this attempt (a stale claim, a takeover)
   * records its Idempotency-Key on it when it has none (HOO-1918), so a retry
   * is answered from the attempt instead of running the action again.
   */
  adoptIdempotencyKey?: string | null;
  updatedAt: string;
}

export interface CreatePaymentRecurringPaymentLifecycleAttemptInput {
  id: string;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  status: PaymentRecurringPaymentAttemptStatus;
  stage: PaymentRecurringPaymentLifecycleAttemptStage;
  signature: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  idempotencyKey?: string | null;
}

export interface UpdatePaymentRecurringPaymentLifecycleAttemptInput {
  attemptId: string;
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentAttemptStatus;
  stage?: PaymentRecurringPaymentLifecycleAttemptStage;
  signature?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * A keyed request that adopts this attempt (a stale claim, a takeover)
   * records its Idempotency-Key on it when it has none (HOO-1918), so a retry
   * is answered from the attempt instead of running the action again.
   */
  adoptIdempotencyKey?: string | null;
  updatedAt: string;
}

/** Looks up the live (not failed) attempt a request's Idempotency-Key claimed. */
export interface FindRecurringPaymentAttemptByIdempotencyKeyInput {
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
}

export interface GetLatestPaymentRecurringPaymentLifecycleAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: PaymentRecurringPaymentLifecycleOperation;
  statuses?: readonly PaymentRecurringPaymentAttemptStatus[];
}

export interface GetLatestPaymentRecurringPaymentActivationAttemptInput {
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  statuses?: readonly PaymentRecurringPaymentAttemptStatus[];
}

export interface ListPaymentRecurringPaymentsInput {
  organizationId: string;
  projectId: string;
  status?: PaymentRecurringPaymentStatus;
  counterpartyId?: string;
  limit: number;
  offset: number;
}

export interface ListPaymentRecurringPaymentsResult {
  rows: PaymentRecurringPaymentRow[];
  total: number;
}

export interface StalePaymentRecurringPaymentUpdateRow {
  id: string;
  organization_id: string;
  project_id: string;
  updated_at: string;
  oldest_updated_at: string;
  stale_count: number;
}

export interface PaymentRecurringPaymentsRepository {
  listStaleLifecyclePayments(params: {
    /** Only rows whose project is in this environment, so one job run reads one cluster. */
    environment: SdpEnvironment;
    staleBefore: string;
    limit: number;
  }): Promise<PaymentRecurringPaymentRow[]>;
  listStaleUpdatePayments(params: {
    /** Only rows whose project is in this environment, so one job run reads one cluster. */
    environment: SdpEnvironment;
    staleBefore: string;
    limit: number;
  }): Promise<StalePaymentRecurringPaymentUpdateRow[]>;
  listRecoverableCollectionPayments(params: {
    /** Only rows whose project is in this environment, so one job run reads one cluster. */
    environment: SdpEnvironment;
    staleBefore: string;
    limit: number;
  }): Promise<RecoverableCollectionRecurringPaymentRow[]>;
  listDueCollectionPayments(params: {
    /** Only rows whose project is in this environment, so one job run reads one cluster. */
    environment: SdpEnvironment;
    dueBefore: string;
    retryBefore: string;
    limit: number;
  }): Promise<CollectibleRecurringPaymentRow[]>;
  createRecurringPayment(
    input: CreatePaymentRecurringPaymentInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  /** The recurring payment created under this Idempotency-Key, if any. */
  findRecurringPaymentByIdempotencyKey(params: {
    organizationId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; idempotencyFingerprint: string | null } | null>;
  updateRecurringPayment(
    input: UpdatePaymentRecurringPaymentInput
  ): Promise<PaymentRecurringPaymentRow | null>;
  /** The stored activator, row-locked for the claim that may replace it. */
  lockRecurringPaymentActivator(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
  }): Promise<StoredRecurringPaymentActivator | null>;
  /** Puts back the activator an abandoned update's claim replaced. */
  restoreRecurringPaymentActivator(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    activator: StoredRecurringPaymentActivator;
  }): Promise<void>;
  claimRecurringPaymentActivation(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
    updatedAt: string;
    staleBefore?: string;
    activatedBy: RecurringPaymentActivator | null;
  }): Promise<PaymentRecurringPaymentRow | null>;
  /**
   * Recurring payments a key activated or last resumed that collect, or will
   * once an operation in flight finishes, for revoke-and-cancel: under this
   * key's id or any id it was rotated from, since rotation mints a new row
   * for the same credential.
   */
  listLiveRecurringPaymentsActivatedByApiKey(params: {
    organizationId: string;
    projectId: string;
    apiKeyId: string;
  }): Promise<PaymentRecurringPaymentRow[]>;
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
  findActivationAttemptByIdempotencyKey(
    input: FindRecurringPaymentAttemptByIdempotencyKeyInput
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
  findLifecycleAttemptByIdempotencyKey(
    input: FindRecurringPaymentAttemptByIdempotencyKeyInput & {
      operation: PaymentRecurringPaymentLifecycleOperation;
    }
  ): Promise<PaymentRecurringPaymentLifecycleAttemptRow | null>;
  createUpdateAttempt(
    input: CreatePaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  updateUpdateAttempt(
    input: UpdatePaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  /**
   * Null a step's saved signature after its send was provably refused, only while the slot still
   * holds that signature.
   *
   * @returns False when the slot no longer holds it.
   */
  clearStepSignature(input: ClearPaymentRecurringPaymentStepSignatureInput): Promise<boolean>;
  getLatestUpdateAttempt(
    input: GetLatestPaymentRecurringPaymentUpdateAttemptInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  findUpdateAttemptByIdempotencyKey(
    input: FindRecurringPaymentAttemptByIdempotencyKeyInput
  ): Promise<PaymentRecurringPaymentUpdateAttemptRow | null>;
  createUpdateEvent(
    input: CreatePaymentRecurringPaymentUpdateEventInput
  ): Promise<PaymentRecurringPaymentUpdateEventRow | null>;
  getRecurringPaymentById(params: {
    recurringPaymentId: string;
    organizationId: string;
    projectId: string;
  }): Promise<PaymentRecurringPaymentRow | null>;
  listRecurringPayments(
    params: ListPaymentRecurringPaymentsInput
  ): Promise<ListPaymentRecurringPaymentsResult>;
}
