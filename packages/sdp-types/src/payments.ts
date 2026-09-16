import type { Address } from "@solana/addresses";
import { z } from "zod";
import type { CountryCode } from "./countries";
import type { CustodyProvider, CustodyWalletAggregate, CustodyWalletTokenBalance } from "./custody";
import type { RampFiatCurrency } from "./generated/ramp.generated";
import type { CryptoAssetSymbol, CryptoRailId, CryptoRailNetwork } from "./payment-rails";
import type {
  PolicyDecision,
  PolicyDefaultAction,
  PolicyProfileStatus,
  PolicyProviderSyncStatus,
  PolicyRule,
  WalletOperationStatus,
} from "./policy";
import type { RampProviderId } from "./provider-access";
import type { PaymentTransactionKind } from "./unified-transactions";

export const RECURRING_PAYMENT_COLLECTION_CONFIG = {
  batchSize: 25,
  maxBatchSize: 100,
  retryAfterMinutes: 30,
  staleAfterMs: 15 * 60 * 1000,
} as const satisfies Record<string, number>;

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export const recurringPaymentPolicyPayloadSchema = z.discriminatedUnion("operationType", [
  z.object({
    operationType: z.literal("recurring_payment_create"),
    counterpartyId: z.string(),
    counterpartyAccountId: z.string(),
    periodHours: z.number().int().positive(),
  }),
  z.object({
    operationType: z.literal("recurring_payment_update"),
    recurringPaymentId: z.string(),
    counterpartyId: z.string(),
    counterpartyAccountId: z.string(),
    periodHours: z.number().int().positive(),
  }),
  z.object({
    operationType: z.literal("recurring_payment_collection"),
    recurringPaymentId: z.string(),
    subscriptionId: z.string(),
    collectionDueAt: z.string(),
  }),
]);
export type RecurringPaymentPolicyPayload = z.infer<typeof recurringPaymentPolicyPayloadSchema>;

export interface PaymentsDashboardWallet {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
  provider?: CustodyProvider;
  custodyConfigId?: string;
  custodyConnectionId?: string;
  isRuntimeExecutionAllowed: boolean;
  balances?: CustodyWalletTokenBalance[];
}

export interface PaymentsDashboardWalletsEnvelope {
  data?: {
    wallets?: PaymentsDashboardWallet[];
  };
  error?: {
    message?: string;
  };
}

export interface PaymentsWalletAggregateEnvelope {
  data?: {
    aggregate?: CustodyWalletAggregate;
  };
  error?: {
    message?: string;
  };
}

export interface PaymentWalletPolicy {
  walletId: string;
  defaultAction: PolicyDefaultAction;
  rules: PolicyRule[];
  controlProfile: PaymentWalletControlProfileSummary | null;
  audit?: PaymentWalletPolicyAudit;
}

export interface PaymentWalletControlProfileSummary {
  id: string;
  status: PolicyProfileStatus;
  activeRevisionId: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
  commitMessage: string | null;
  defaultAction: PolicyDefaultAction;
  rules: PolicyRule[];
  providerMappingStatus: PolicyProviderSyncStatus;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface PaymentWalletPolicyEnvelope {
  data?: {
    policy?: PaymentWalletPolicy;
  };
  error?: {
    message?: string;
  };
}

export interface PaymentWalletPolicyAudit {
  recentEvaluations: PaymentWalletPolicyAuditEntry[];
}

/**
 * Historical read model: rows predating a vocabulary trim keep their retired
 * operation family/type strings, so these fields are not narrowed to the live
 * enums.
 */
export interface PaymentWalletPolicyAuditEntry {
  walletOperationId: string;
  policyEvaluationId: string;
  operationFamily: string;
  operationType: string;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  status: WalletOperationStatus;
  decision: PolicyDecision;
  reasonCode: string;
  reason: string | null;
  requiresApproval: boolean;
  approvalRequestId: string | null;
  operationCreatedAt: string;
  operationUpdatedAt: string;
  evaluatedAt: string;
}

export const PAYMENT_TRANSFER_TYPES = ["transfer", "transfer_batch", "onramp", "offramp"] as const;

export type PaymentTransferType = (typeof PAYMENT_TRANSFER_TYPES)[number];

/** Transfer types SDP signs from a custody wallet; ramps settle through a provider instead. */
export const WALLET_TRANSFER_TYPES = [
  "transfer",
  "transfer_batch",
] as const satisfies readonly PaymentTransferType[];

export const RAMP_TRANSFER_TYPES = [
  "onramp",
  "offramp",
] as const satisfies readonly PaymentTransferType[];

export type RampTransferType = (typeof RAMP_TRANSFER_TYPES)[number];

export function isRampTransferType(type: PaymentTransferType): type is RampTransferType {
  return RAMP_TRANSFER_TYPES.some((rampType) => rampType === type);
}

/**
 * Lifecycle of a persisted ramp webhook event: `pending` until the background
 * apply or the replay job settles it (applied rows are deleted, not kept), and
 * `failed` once replay attempts are exhausted and an operator has to look.
 */
export const RAMP_WEBHOOK_EVENT_STATUSES = ["pending", "failed"] as const;

export type RampWebhookEventStatus = (typeof RAMP_WEBHOOK_EVENT_STATUSES)[number];

export const PAYMENT_TRANSFER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
  "awaiting_payment",
  "settling",
  "completed",
  "canceled",
  "expired",
] as const;

export type PaymentTransferStatus = (typeof PAYMENT_TRANSFER_STATUSES)[number];

export const SUCCESSFUL_PAYMENT_TRANSFER_STATUSES = [
  "completed",
  "confirmed",
  "finalized",
] as const satisfies readonly PaymentTransferStatus[];

/** Reports whether a transfer already settled successfully, so later reconciliation must not regress it. */
export function isSuccessfulPaymentTransferStatus(status: PaymentTransferStatus): boolean {
  return SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.some((candidate) => candidate === status);
}

/** Whether each status ends a ramp transfer's lifecycle. Scoped to ramps — onchain sends terminate at `finalized`. */
export const RAMP_TRANSFER_STATUS_TERMINAL = {
  pending: false,
  processing: false,
  confirmed: false,
  finalized: false,
  failed: true,
  awaiting_payment: false,
  settling: false,
  completed: true,
  canceled: true,
  expired: true,
} as const satisfies Record<PaymentTransferStatus, boolean>;

/** Reports whether a ramp transfer can never leave the given status. */
export function isTerminalRampTransferStatus(status: PaymentTransferStatus): boolean {
  return RAMP_TRANSFER_STATUS_TERMINAL[status];
}

/** Whether a ramp transfer in each status can still be canceled: only before the customer has funded it. */
export const RAMP_TRANSFER_STATUS_CANCELABLE = {
  pending: true,
  processing: false,
  confirmed: false,
  finalized: false,
  failed: false,
  awaiting_payment: true,
  settling: false,
  completed: false,
  canceled: false,
  expired: false,
} as const satisfies Record<PaymentTransferStatus, boolean>;

/** Reports whether a ramp transfer in the given status can still be canceled. */
export function isCancelableRampTransferStatus(status: PaymentTransferStatus): boolean {
  return RAMP_TRANSFER_STATUS_CANCELABLE[status];
}

/** The statuses a ramp transfer can be canceled from, for status-guarded updates. */
export const CANCELABLE_RAMP_TRANSFER_STATUSES = PAYMENT_TRANSFER_STATUSES.filter(
  (status) => RAMP_TRANSFER_STATUS_CANCELABLE[status]
);

/** The statuses that end a ramp transfer's lifecycle, for status-guarded updates. */
export const TERMINAL_RAMP_TRANSFER_STATUSES = PAYMENT_TRANSFER_STATUSES.filter(
  (status) => RAMP_TRANSFER_STATUS_TERMINAL[status]
);

/** Whether a ramp transfer in each status may still be completed by a provider settlement webhook. */
export const RAMP_TRANSFER_STATUS_SETTLEABLE = {
  pending: true,
  processing: false,
  confirmed: false,
  finalized: false,
  failed: false,
  awaiting_payment: true,
  settling: true,
  completed: false,
  canceled: false,
  expired: false,
} as const satisfies Record<PaymentTransferStatus, boolean>;

/** Statuses a funded ramp transfer may still be completed from; a provider settlement webhook completes it. */
export const SETTLEABLE_RAMP_TRANSFER_STATUSES = PAYMENT_TRANSFER_STATUSES.filter(
  (status) => RAMP_TRANSFER_STATUS_SETTLEABLE[status]
);

/** Lifecycle of a wallet-to-address onchain transfer; the ramp-only statuses never apply to it. */
export const ONCHAIN_TRANSFER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
] as const satisfies readonly PaymentTransferStatus[];

export type OnchainTransferStatus = (typeof ONCHAIN_TRANSFER_STATUSES)[number];

/** Onchain transfer statuses that still await a chain verdict. */
export const ONCHAIN_TRANSFER_IN_FLIGHT_STATUSES = [
  "pending",
  "processing",
] as const satisfies readonly OnchainTransferStatus[];

/** Onchain transfer statuses whose transaction landed; confirmed still awaits finality. */
export const ONCHAIN_TRANSFER_SETTLED_STATUSES = [
  "confirmed",
  "finalized",
] as const satisfies readonly OnchainTransferStatus[];

/** The statuses a chain lookup can settle a processing transfer into. */
export const TRANSFER_CHAIN_VERDICT_STATUSES = [
  "confirmed",
  "finalized",
  "failed",
] as const satisfies readonly OnchainTransferStatus[];

export type TransferChainVerdictStatus = (typeof TRANSFER_CHAIN_VERDICT_STATUSES)[number];

export const PAYMENT_TRANSFER_STATUS_TONES = ["success", "pending", "danger", "neutral"] as const;

export type PaymentTransferStatusTone = (typeof PAYMENT_TRANSFER_STATUS_TONES)[number];

/** How each transfer status reads to a person: settled, still moving, failed, or lapsed without loss. */
export const PAYMENT_TRANSFER_STATUS_TONE = {
  pending: "pending",
  processing: "pending",
  confirmed: "success",
  finalized: "success",
  failed: "danger",
  awaiting_payment: "pending",
  settling: "pending",
  completed: "success",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentTransferStatus, PaymentTransferStatusTone>;

export interface LightsparkGridAmount {
  amount: number;
  currencyCode: string;
  decimals: number;
}

/** MoonPay transaction economics, captured verbatim from a terminal webhook. */
export interface MoonpayRampSettlement {
  provider: "moonpay";
  status: "completed" | "failed";
  /** MoonPay's own transaction id — the key for their transaction receipt page. */
  transactionId: string;
  baseCurrencyCode: string;
  baseCurrencyAmount: number;
  quoteCurrencyCode: string;
  quoteCurrencyAmount: number;
  feeAmount: number;
  extraFeeAmount: number;
  networkFeeAmount: number;
  areFeesIncluded: boolean;
  usdRate: number;
  cryptoTransactionId?: string;
  failureReason?: string;
}

/** Lightspark (Grid) outgoing-payment economics, captured verbatim from a terminal webhook. */
export interface LightsparkRampSettlement {
  provider: "lightspark";
  status: "COMPLETED" | "FAILED" | "EXPIRED" | "REFUND_FAILED";
  sentAmount: LightsparkGridAmount;
  receivedAmount: LightsparkGridAmount;
  exchangeRate: number;
  fees: number;
  settledAt?: string;
  failureReason?: string;
}

export interface CoinbaseRampFee {
  feeAmount: string;
  feeCurrency: string;
  feeType: string;
}

/** Coinbase onramp order economics, captured verbatim from a terminal webhook. */
export interface CoinbaseRampSettlement {
  provider: "coinbase";
  status: "completed" | "failed";
  paymentCurrency: string;
  paymentSubtotal: string;
  paymentTotal: string;
  purchaseCurrency: string;
  purchaseAmount: string;
  exchangeRate: string;
  fees: CoinbaseRampFee[];
  txHash?: string;
  failureReason?: string;
}

export type RampTransferSettlement =
  | MoonpayRampSettlement
  | LightsparkRampSettlement
  | CoinbaseRampSettlement;

/** Where an off-ramp sale expects the crypto deposit, reported by the provider while awaiting payment. */
export interface RampCryptoDeposit {
  /** Provider-owned wallet address the crypto must be sent to. */
  destinationAddress: string;
  /** Crypto amount the provider expects, in display units. */
  amount: string;
}

export interface MoneygramTransferDetails {
  transactionId?: string;
  referenceNumber?: string;
  payoutAmount?: number;
  payoutStatus?: string;
  cryptoTransferId?: string;
  solanaTxSignature?: string;
  lastWidgetError?: string;
}

export interface PaymentTransferSummary {
  id: string;
  custodyWalletId: string | null;
  providerWalletId: string;
  status: PaymentTransferStatus;
  signature: string | null;
  error?: string | null;
  type?: PaymentTransferType;
  kind?: PaymentTransactionKind;
  direction?: string;
  source?: string;
  destination?: string;
  token?: string;
  amount?: string;
  memo?: string;
  rampsMemo: Record<string, string>;
  provider?: RampProviderId;
  counterpartyId?: string;
  counterpartyDisplayName?: string;
  providerReference?: string;
  deliveryMode?: PaymentRampQuoteDeliveryMode;
  fiatCurrency?: string;
  fiatAmount?: string;
  settlement?: RampTransferSettlement;
  cryptoDeposit?: RampCryptoDeposit;
  moneygram?: MoneygramTransferDetails;
  createdAt?: string;
  updatedAt?: string;
}

export interface PreparedPaymentTransaction {
  serialized: string;
  blockhash: string;
  lastValidBlockHeight?: string;
}

export interface PreparedPaymentSubscriptionTransaction extends PreparedPaymentTransaction {
  requiredSigners: string[];
}

export interface PaymentTransferRequest {
  projectId?: string;
  sourceCustodyWalletId: string;
  destination: string;
  token: string;
  amount: string;
  memo?: string;
}

export interface PaymentTransferEnvelope {
  data?: {
    transfer?: PaymentTransferSummary;
  };
  error?: {
    message?: string;
  };
}

export type PaymentTransferBatchStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "failed"
  | "partially_failed"
  | "archived";

export type PaymentTransferBatchRecipientStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "failed"
  | "archived";

export interface PaymentTransferBatchRecipientRequest {
  externalId?: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  amount: string;
}

export interface PaymentTransferBatchOptions {
  maxRecipientsPerTransaction?: number;
  priorityFee?: "none" | "low" | "medium" | "high" | "auto";
  preflight?: boolean;
}

export interface PaymentTransferBatchRequest {
  projectId?: string;
  externalId?: string;
  sourceCustodyWalletId: string;
  token: string;
  recipients: PaymentTransferBatchRecipientRequest[];
  options?: PaymentTransferBatchOptions;
}

export type PaymentTransferBatchEstimateRequest = PaymentTransferBatchRequest;

export interface PaymentTransferBatch {
  id: string;
  organizationId: string;
  projectId: string;
  externalId: string | null;
  sourceCustodyWalletId: string | null;
  sourceProviderWalletId: string;
  sourceAddress: string;
  token: string;
  status: PaymentTransferBatchStatus;
  totalAmount: string | null;
  recipientCount: number;
  transactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentTransferRecipient {
  id: string;
  batchId: string;
  transferId: string | null;
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destination: string;
  amount: string;
  status: PaymentTransferBatchRecipientStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const COUNTERPARTY_ACCOUNT_SUMMARY_TYPES = ["crypto_account"] as const;

export type CounterpartyAccountSummaryType = (typeof COUNTERPARTY_ACCOUNT_SUMMARY_TYPES)[number];

export interface CounterpartyAccountSummary {
  counterpartyId: string;
  counterpartyAccountId: string;
  name: string;
  address: string;
  label: string | null;
}

export interface ListProjectCounterpartyAccountsResponse {
  accounts: CounterpartyAccountSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListProjectCounterpartyAccountsEnvelope {
  data?: ListProjectCounterpartyAccountsResponse;
  error?: {
    message?: string;
  };
}

export interface PaymentTransferBatchEstimate {
  recipientCount: number;
  transactionCount: number;
  estimatedFees: {
    networkFeeLamports: string;
    priorityFeeLamports: string;
    tokenAccountRentLamports: string;
    sponsored: boolean;
  };
}

export interface PaymentTransferBatchEnvelope {
  data?: {
    batch?: PaymentTransferBatch;
    recipients?: PaymentTransferRecipient[];
    transfers?: PaymentTransferSummary[];
  };
  error?: {
    message?: string;
  };
}

export interface PaymentTransferBatchEstimateEnvelope {
  data?: {
    estimate?: PaymentTransferBatchEstimate;
  };
  error?: {
    message?: string;
  };
}

export const PAYMENT_SUBSCRIPTION_PLAN_STATUSES = ["draft", "active", "archived"] as const;
export type PaymentSubscriptionPlanStatus = (typeof PAYMENT_SUBSCRIPTION_PLAN_STATUSES)[number];

export const PAYMENT_SUBSCRIPTION_STATUSES = [
  "pending_authorization",
  "active",
  "paused",
  "canceling",
  "canceled",
  "expired",
] as const;
export type PaymentSubscriptionStatus = (typeof PAYMENT_SUBSCRIPTION_STATUSES)[number];

export const PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "failed",
  "skipped",
] as const;
export type PaymentSubscriptionCollectionAttemptStatus =
  (typeof PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES)[number];

const collectionAttemptMetadataBaseSchema = z.object({
  recurringPaymentId: z.string(),
  initiatedByKeyId: z.string().nullable(),
});
export const paymentSubscriptionCollectionAttemptMetadataSchema = z.discriminatedUnion("source", [
  collectionAttemptMetadataBaseSchema.extend({ source: z.literal("manual") }),
  collectionAttemptMetadataBaseSchema.extend({ source: z.literal("automated") }),
  collectionAttemptMetadataBaseSchema.extend({
    source: z.literal("retry"),
    initialSource: z.enum(["manual", "automated"]),
    transferId: z.string().nullable(),
    error: z.string(),
    retryAfterAt: z.string(),
  }),
  collectionAttemptMetadataBaseSchema.extend({
    source: z.literal("linked_transfer"),
    initialSource: z.enum(["manual", "automated"]),
    transferId: z.string(),
  }),
]);
export type PaymentSubscriptionCollectionAttemptMetadata = z.infer<
  typeof paymentSubscriptionCollectionAttemptMetadataSchema
>;

export const PAYMENT_RECURRING_PAYMENT_STATUSES = [
  "pending_activation",
  "activating",
  "active",
  "updating",
  "canceling",
  "resuming",
  "paused",
  "canceled",
  "expired",
] as const;
export type PaymentRecurringPaymentStatus = (typeof PAYMENT_RECURRING_PAYMENT_STATUSES)[number];

export const PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES = [
  "processing",
  "confirmed",
  "failed",
] as const;
export type PaymentRecurringPaymentAttemptStatus =
  (typeof PAYMENT_RECURRING_PAYMENT_ATTEMPT_STATUSES)[number];

export const PAYMENT_RECURRING_PAYMENT_ACTIVATION_ATTEMPT_STAGES = [
  "claim",
  "create_plan",
  "authorize_subscription",
  "finalize",
] as const;
export type PaymentRecurringPaymentActivationAttemptStage =
  (typeof PAYMENT_RECURRING_PAYMENT_ACTIVATION_ATTEMPT_STAGES)[number];
export const PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS = ["cancel", "resume"] as const;
export type PaymentRecurringPaymentLifecycleOperation =
  (typeof PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS)[number];
export const PAYMENT_RECURRING_PAYMENT_LIFECYCLE_ATTEMPT_STAGES = [
  "claim",
  "submit",
  "finalize",
] as const;
export type PaymentRecurringPaymentLifecycleAttemptStage =
  (typeof PAYMENT_RECURRING_PAYMENT_LIFECYCLE_ATTEMPT_STAGES)[number];
export const PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_MODES = [
  "metadata_schedule",
  "replacement",
] as const;
export type PaymentRecurringPaymentUpdateAttemptMode =
  (typeof PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_MODES)[number];
export const PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_STAGES = [
  "claim",
  "update_plan",
  "create_plan",
  "authorize_subscription",
  "cancel_old_subscription",
  "finalize",
] as const;
export type PaymentRecurringPaymentUpdateAttemptStage =
  (typeof PAYMENT_RECURRING_PAYMENT_UPDATE_ATTEMPT_STAGES)[number];

export const PAYMENT_RECURRING_PAYMENT_ACTIONS = [
  "activate",
  "collect",
  "cancel",
  "resume",
] as const;
export type PaymentRecurringPaymentAction = (typeof PAYMENT_RECURRING_PAYMENT_ACTIONS)[number];
export const PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS = ["24", "168", "720", "custom"] as const;
export type PaymentRecurringPaymentSchedulePreset =
  (typeof PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS)[number];
export const PAYMENT_RECURRING_PAYMENT_TRANSITION_RESULTS = [
  "already_final",
  "claimable",
  "recoverable",
  "processing",
  "invalid",
] as const;
export type PaymentRecurringPaymentTransitionResult =
  (typeof PAYMENT_RECURRING_PAYMENT_TRANSITION_RESULTS)[number];

export const EDITABLE_RECURRING_PAYMENT_STATUSES = [
  "pending_activation",
  "active",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export function isEditableRecurringPaymentStatus(status: PaymentRecurringPaymentStatus): boolean {
  return EDITABLE_RECURRING_PAYMENT_STATUSES.some((candidate) => candidate === status);
}
export const COLLECTABLE_RECURRING_PAYMENT_STATUSES = [
  "active",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export function isCollectableRecurringPaymentStatus(
  status: PaymentRecurringPaymentStatus
): boolean {
  return COLLECTABLE_RECURRING_PAYMENT_STATUSES.some((candidate) => candidate === status);
}
export function isPendingActivationRecurringPaymentStatus(
  status: PaymentRecurringPaymentStatus
): boolean {
  return status === PAYMENT_RECURRING_PAYMENT_STATUSES[0];
}
export function isActivatingRecurringPaymentStatus(status: PaymentRecurringPaymentStatus): boolean {
  return status === PAYMENT_RECURRING_PAYMENT_STATUSES[1];
}
export function isUpdatingRecurringPaymentStatus(status: PaymentRecurringPaymentStatus): boolean {
  return status === PAYMENT_RECURRING_PAYMENT_STATUSES[3];
}
export const RECURRING_PAYMENT_STATUSES_REQUIRING_REACTIVATION = [
  "paused",
  "expired",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export function doesRecurringPaymentStatusRequireReactivation(
  status: PaymentRecurringPaymentStatus
): boolean {
  return RECURRING_PAYMENT_STATUSES_REQUIRING_REACTIVATION.some(
    (candidate) => candidate === status
  );
}
export const COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE = [
  "pending",
  "processing",
  "confirmed",
] as const satisfies readonly PaymentSubscriptionCollectionAttemptStatus[];
export const COLLECTION_ATTEMPT_STATUSES_WITH_SUBMITTED_TRANSFER = [
  "processing",
  "confirmed",
] as const satisfies readonly PaymentSubscriptionCollectionAttemptStatus[];
export const FAILED_COLLECTION_ATTEMPT_STATUSES = [
  "failed",
] as const satisfies readonly PaymentSubscriptionCollectionAttemptStatus[];
export const COLLECTION_ATTEMPT_INITIAL_STATUSES = [
  "processing",
  "failed",
] as const satisfies readonly PaymentSubscriptionCollectionAttemptStatus[];
export type PaymentSubscriptionCollectionAttemptInitialStatus =
  (typeof COLLECTION_ATTEMPT_INITIAL_STATUSES)[number];
export const IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES = [
  "processing",
] as const satisfies readonly PaymentRecurringPaymentAttemptStatus[];
export const RECURRING_PAYMENT_STATUSES_IN_FLIGHT_LIFECYCLE = [
  "canceling",
  "resuming",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export const RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON = [
  "activating",
  ...RECURRING_PAYMENT_STATUSES_IN_FLIGHT_LIFECYCLE,
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export const RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION = [
  "active",
  "canceling",
  "canceled",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export type RecurringPaymentStatusWithRecoverableCollection =
  (typeof RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION)[number];
export function hasRecoverableRecurringPaymentCollection(
  status: PaymentRecurringPaymentStatus
): boolean {
  return RECURRING_PAYMENT_STATUSES_WITH_RECOVERABLE_COLLECTION.some(
    (candidate) => candidate === status
  );
}
export const RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS = {
  cancel: { processingStatus: "canceling", claimableStatus: "active", finalStatus: "canceled" },
  resume: { processingStatus: "resuming", claimableStatus: "canceled", finalStatus: "active" },
} as const satisfies Record<
  PaymentRecurringPaymentLifecycleOperation,
  {
    processingStatus: PaymentRecurringPaymentStatus;
    claimableStatus: PaymentRecurringPaymentStatus;
    finalStatus: PaymentRecurringPaymentStatus;
  }
>;

export const RECURRING_PAYMENT_ACTIVATION_TRANSITION = {
  processingStatus: "activating",
  claimableStatus: "pending_activation",
  finalStatus: "active",
} as const satisfies Record<
  "processingStatus" | "claimableStatus" | "finalStatus",
  PaymentRecurringPaymentStatus
>;

export const RECURRING_PAYMENT_UPDATE_TRANSITION = {
  processingStatus: "updating",
  claimableStatuses: EDITABLE_RECURRING_PAYMENT_STATUSES,
} as const satisfies {
  processingStatus: PaymentRecurringPaymentStatus;
  claimableStatuses: readonly PaymentRecurringPaymentStatus[];
};

export function isCanceledRecurringPaymentStatus(status: PaymentRecurringPaymentStatus): boolean {
  return status === RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS.cancel.finalStatus;
}

export function recurringPaymentInFlightLifecycleOperation(
  status: PaymentRecurringPaymentStatus
): PaymentRecurringPaymentLifecycleOperation | null {
  for (const operation of PAYMENT_RECURRING_PAYMENT_LIFECYCLE_OPERATIONS) {
    if (status === RECURRING_PAYMENT_LIFECYCLE_TRANSITIONS[operation].processingStatus) {
      return operation;
    }
  }
  return null;
}

export interface PaymentSubscriptionPlan {
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

export interface PaymentSubscription {
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
  cancelAt: string | null;
  canceledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentSubscriptionCollectionAttempt {
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
  metadata: PaymentSubscriptionCollectionAttemptMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecurringPayment {
  id: string;
  organizationId: string;
  projectId: string;
  sourceCustodyWalletId: string | null;
  sourceProviderWalletId: string;
  sourceAddress: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  destinationTokenAccount: string | null;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  nextCollectionDueAt: string | null;
  planId: string | null;
  subscriptionId: string | null;
  planPda: string | null;
  planCreatedAt: string | null;
  planCreationSignature: string | null;
  subscriptionPda: string | null;
  subscriptionAuthorityAddress: string | null;
  authorizationSignature: string | null;
  status: PaymentRecurringPaymentStatus;
  metadataUri: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PaymentRequestStatus = "awaiting_payment" | "paid" | "canceled" | "expired";

export interface PaymentRequestLifecycleEvent {
  status: PaymentRequestStatus;
  at: string;
}

export interface PaymentRequest {
  id: string;
  publicToken: string;
  organizationId: string;
  projectId: string | null;
  counterpartyId: string | null;
  walletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  reference: string;
  status: PaymentRequestStatus;
  expiresAt: string | null;
  fulfilledByTransferId: string | null;
  canceledBy: string | null;
  lifecycle: PaymentRequestLifecycleEvent[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentRequestsResponse {
  paymentRequests: PaymentRequest[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreatePaymentSubscriptionPlanRequest {
  ownerWalletId: string;
  token: string;
  amount: string;
  periodHours: number;
  programPlanId?: string;
  planPda?: string;
  destinationAddress?: string;
  pullerWalletId?: string;
  metadataUri?: string;
  status?: PaymentSubscriptionPlanStatus;
}

export interface UpdatePaymentSubscriptionPlanRequest {
  planPda?: string | null;
  destinationAddress?: string | null;
  pullerWalletId?: string | null;
  metadataUri?: string | null;
  status?: PaymentSubscriptionPlanStatus;
}

export interface CreatePaymentSubscriptionRequest {
  planId: string;
  counterpartyId: string;
  subscriberAddress: string;
  subscriberTokenAccount?: string;
  subscriptionPda?: string;
  subscriptionAuthorityAddress?: string;
  authorizationSignature?: string;
  status?: PaymentSubscriptionStatus;
  currentPeriodStartAt?: string;
  nextCollectionDueAt?: string;
}

export interface UpdatePaymentSubscriptionRequest {
  subscriberTokenAccount?: string | null;
  subscriptionPda?: string | null;
  subscriptionAuthorityAddress?: string | null;
  authorizationSignature?: string | null;
  status?: PaymentSubscriptionStatus;
  currentPeriodStartAt?: string | null;
  nextCollectionDueAt?: string | null;
  cancelAt?: string | null;
  canceledAt?: string | null;
}

export interface CreatePaymentSubscriptionCollectionAttemptRequest {
  amount?: string;
  token?: string;
  dueAt?: string;
  attemptedAt?: string;
  status?: PaymentSubscriptionCollectionAttemptStatus;
  transferId?: string;
  signature?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentRecurringPaymentRequest {
  sourceCustodyWalletId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
  metadataUri?: string;
}

export interface UpdatePaymentRecurringPaymentRequest {
  sourceCustodyWalletId?: string;
  counterpartyId?: string;
  counterpartyAccountId?: string;
  token?: string;
  amount?: string;
  periodHours?: number;
  firstCollectionAt?: string | null;
  nextCollectionDueAt?: string | null;
  metadataUri?: string | null;
}

export interface PaymentRecurringPaymentResponse {
  recurringPayment: PaymentRecurringPayment;
}

export interface PaymentRecurringPaymentCollectionResponse {
  recurringPayment: PaymentRecurringPayment;
  collectionAttempt: PaymentSubscriptionCollectionAttempt;
  transfer: PaymentTransferSummary;
}

export interface ListPaymentRecurringPaymentsResponse {
  recurringPayments: PaymentRecurringPayment[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaymentSubscriptionPlanResponse {
  subscriptionPlan: PaymentSubscriptionPlan;
}

export interface PreparePaymentSubscriptionPlanResponse {
  subscriptionPlan: PaymentSubscriptionPlan;
  preparedTransaction: PreparedPaymentSubscriptionTransaction;
  planPda: string;
}

export interface ListPaymentSubscriptionPlansResponse {
  subscriptionPlans: PaymentSubscriptionPlan[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaymentSubscriptionResponse {
  subscription: PaymentSubscription;
}

export interface PreparePaymentSubscriptionAuthorizationResponse {
  subscription: PaymentSubscription;
  preparedTransaction: PreparedPaymentSubscriptionTransaction;
  subscriptionPda: string;
  subscriptionAuthorityAddress: string;
}

export interface PreparePaymentSubscriptionLifecycleResponse {
  subscription: PaymentSubscription;
  preparedTransaction: PreparedPaymentSubscriptionTransaction;
}

export interface ListPaymentSubscriptionsResponse {
  subscriptions: PaymentSubscription[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaymentSubscriptionCollectionAttemptResponse {
  collectionAttempt: PaymentSubscriptionCollectionAttempt;
}

export interface PreparePaymentSubscriptionCollectionResponse {
  subscription: PaymentSubscription;
  preparedTransaction: PreparedPaymentSubscriptionTransaction;
  collectionAttempt?: PaymentSubscriptionCollectionAttempt;
}

export interface ListPaymentSubscriptionCollectionAttemptsResponse {
  collectionAttempts: PaymentSubscriptionCollectionAttempt[];
  total: number;
  page: number;
  pageSize: number;
}

export type PaymentRampExecutionStatus = "pending" | "processing" | "completed" | "failed";

export interface CryptoDepositPaymentRampInstruction {
  provider: RampProviderId;
  kind: "crypto_deposit";
  /** Solana address the user should send crypto to. */
  destinationAddress: Address;
  /** SDP-supported crypto asset to send. */
  cryptoCurrency: CryptoAssetSymbol;
  /** SDP-supported blockchain network for the destination address. */
  network: CryptoRailNetwork;
  /** Provider-side reference or memo required to match the deposit, when applicable. */
  reference?: string;
  instructionsNotes?: string;
}

export interface LightsparkProviderPaymentRampInstruction {
  provider: "lightspark";
  accountOrWalletInfo: {
    accountType: string;
    accountNumber?: string;
    routingNumber?: string;
    paymentRails?: string[];
    reference?: string;
    bankName?: string;
    address?: Address;
    assetType?: CryptoAssetSymbol;
  };

  instructionsNotes?: string;
  isPlatformAccount?: boolean;
}

export type LightsparkCryptoDepositPaymentRampInstruction =
  LightsparkProviderPaymentRampInstruction &
    CryptoDepositPaymentRampInstruction & {
      provider: "lightspark";
      accountOrWalletInfo: LightsparkProviderPaymentRampInstruction["accountOrWalletInfo"] & {
        accountType: "SOLANA_WALLET";
        address: Address;
        assetType: CryptoAssetSymbol;
      };
    };

export type LightsparkPaymentRampInstruction =
  | LightsparkProviderPaymentRampInstruction
  | LightsparkCryptoDepositPaymentRampInstruction;

export type BvnkOnboardingStatus =
  | "verification_required"
  | "verifying"
  | "verification_failed"
  | "provisioning"
  | "ready";

export interface BvnkBankFundingDetails {
  accountNumber?: string;
  code?: string;
  accountNumberFormat?: string;
  paymentReference?: string;
  bankName?: string;
}

/** On-ramp: fund a fiat virtual account to receive crypto. */
export interface BvnkFiatFundingInstruction {
  provider: "bvnk";
  kind: "fiat_funding";
  onboardingStatus: BvnkOnboardingStatus;
  verificationUrl?: string;
  ruleId?: string;
  ruleStatus?: string;
  fundingWalletId?: string;
  fiatCurrency: string;
  beneficiaryAddress: string;
  network: string;
  bankAccount?: BvnkBankFundingDetails;
  instructionsNotes: string;
}

/** Off-ramp: send crypto to a deposit address; BVNK converts and pays out fiat. */
export interface BvnkCryptoDepositInstruction extends CryptoDepositPaymentRampInstruction {
  provider: "bvnk";
  fiatCurrency: RampFiatCurrency;
  reference: string;
  instructionsNotes: string;
}

export type BvnkPaymentRampInstruction = BvnkFiatFundingInstruction | BvnkCryptoDepositInstruction;

export const MURAL_SANDBOX_PAYIN_CURRENCIES = ["USD", "MXN", "BRL", "ARS"] as const;
export type MuralSandboxPayinCurrency = (typeof MURAL_SANDBOX_PAYIN_CURRENCIES)[number];

/** Narrows a fiat currency to the corridors Mural's sandbox payin simulation supports. */
export function isMuralSandboxPayinCurrency(value: string): value is MuralSandboxPayinCurrency {
  return (MURAL_SANDBOX_PAYIN_CURRENCIES as readonly string[]).includes(value);
}

export interface MuralPaymentRampInstruction {
  provider: "mural";
  fiatCurrency: string;
  payinRails: string[];
  bankDetails: Record<string, string>;
}

export type PaymentRampInstruction =
  | LightsparkPaymentRampInstruction
  | BvnkPaymentRampInstruction
  | MuralPaymentRampInstruction;

export type RampDirection = "onramp" | "offramp";

export interface PaymentRampEstimateFees {
  currency: RampFiatCurrency | CryptoAssetSymbol;
  total: string;
  network?: string;
  networkCurrency?: RampFiatCurrency | CryptoAssetSymbol;
  provider?: string;
  providerCurrency?: RampFiatCurrency | CryptoAssetSymbol;
}

export interface PaymentRampEstimate {
  provider: RampProviderId;
  direction: RampDirection;
  fiatCurrency: RampFiatCurrency;
  assetRail: CryptoRailId;
  fiatAmount: string;
  cryptoAmount: string;
  exchangeRate: string;
  fees: PaymentRampEstimateFees;
  minFiatAmount?: string;
  maxFiatAmount?: string;
  expiresAt?: string;
}

export interface RampProviderEstimateSuccess {
  provider: RampProviderId;
  status: "ok";
  estimate: PaymentRampEstimate;
}

/** The provider supports this pair, but the rate is only known at quote time. */
export interface RampProviderEstimateUnsupported {
  provider: RampProviderId;
  status: "unsupported";
}

export interface RampProviderEstimateError {
  provider: RampProviderId;
  status: "error";
  error: string;
}

export type RampProviderEstimateResult =
  | RampProviderEstimateSuccess
  | RampProviderEstimateUnsupported
  | RampProviderEstimateError;

export interface PaymentRampEstimateEnvelope {
  data?: {
    estimates?: RampProviderEstimateResult[];
  };
  error?: {
    message?: string;
  };
}

export const RAMPS_MEMO_LIMITS = {
  maxEntries: 20,
  maxKeyLength: 64,
  maxValueLength: 256,
} as const satisfies Record<string, number>;

export interface PaymentOnrampQuoteRequest {
  provider: RampProviderId;
  counterpartyId: string;
  destinationCustodyWalletId: string;
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  fiatAmount: string;
  domain?: string;
  rampsMemo?: Record<string, string>;
}

interface PaymentOfframpQuoteRequestBase {
  counterpartyId: string;
  sourceCustodyWalletId: string;
  assetRail: CryptoRailId;
  cryptoAmount: string;
  rampsMemo?: Record<string, string>;
}

/**
 * Off-ramp quote request. Lightspark payouts are corridor-addressed: the
 * fiat currency and destination country select the payout external account,
 * so both are required on that arm.
 */
export type PaymentOfframpQuoteRequest =
  | (PaymentOfframpQuoteRequestBase & {
      provider: "lightspark";
      fiatCurrency: RampFiatCurrency;
      destinationCountry: CountryCode;
      providerAccountId?: string;
    })
  | (PaymentOfframpQuoteRequestBase & {
      provider: Exclude<RampProviderId, "lightspark">;
      fiatCurrency?: RampFiatCurrency;
    });

export type PaymentRampQuoteDeliveryMode = "manual_instructions" | "hosted" | "session_widget";

export interface PaymentRampQuoteCurrency {
  code: string;
  decimals: number;
  name?: string;
  symbol?: string;
}

interface BasePaymentRampQuote {
  id: string;
  provider: RampProviderId;
  status: PaymentRampExecutionStatus;
  deliveryMode: PaymentRampQuoteDeliveryMode;
}

export type PaymentRampQuote =
  | (BasePaymentRampQuote & {
      provider: "lightspark";
      deliveryMode: "manual_instructions";
      /** Bank/wallet funding instructions to send the fiat to. */
      paymentInstructions?: LightsparkPaymentRampInstruction[];
      /** Units of destination crypto per unit of source fiat. */
      exchangeRate?: number;
      /** Total sending amount in the fiat currency's smallest unit, including provider fees. */
      totalSendingAmount?: number;
      sendingCurrency: PaymentRampQuoteCurrency;
      /** Final crypto amount received in its smallest unit. */
      totalReceivingAmount?: number;
      receivingCurrency: PaymentRampQuoteCurrency;
      /** Fees included in the sending amount, denominated in the fiat currency's smallest unit. */
      feesIncluded?: number;
      feeCurrency: PaymentRampQuoteCurrency;
      /** ISO timestamp after which the locked rate is no longer valid. */
      expiresAt?: string;
    })
  | (BasePaymentRampQuote & {
      provider: "bvnk";
      deliveryMode: "manual_instructions";
      /** BVNK fiat virtual-account funding instructions; fund these to receive crypto. */
      paymentInstructions: BvnkPaymentRampInstruction[];
    })
  | (BasePaymentRampQuote & {
      provider: "mural";
      deliveryMode: "manual_instructions";
      paymentInstructions: MuralPaymentRampInstruction[];
    })
  | (BasePaymentRampQuote & {
      provider: "moonpay" | "bvnk";
      deliveryMode: "hosted";
      hostedUrl: string;
    })
  | (BasePaymentRampQuote & {
      provider: "coinbase";
      deliveryMode: "hosted";
      hostedUrl: string;
      /** Order economics captured verbatim from the Coinbase create-order response. */
      paymentCurrency: string;
      paymentSubtotal: string;
      paymentTotal: string;
      purchaseCurrency: string;
      purchaseAmount: string;
      exchangeRate: string;
      fees: CoinbaseRampFee[];
    })
  | (BasePaymentRampQuote & {
      provider: "moneygram";
      deliveryMode: "session_widget";
      /** Short-lived (1h) widget session JWT minted from the MoneyGram session API. */
      sessionToken: string;
      sessionId: string;
      widgetUrl: string;
      /** ISO timestamp when the widget session expires (decoded from the session JWT). */
      expiresAt?: string;
    })
  | (BasePaymentRampQuote & {
      provider: "stripe";
      deliveryMode: "session_widget";
      clientSecret: string;
      sessionId: string;
      publishableKey: string;
      redirectUrl?: string;
    });

export const RAMP_EVENT_PROVIDERS = ["moneygram", "coinbase"] as const;
export type RampEventProvider = (typeof RAMP_EVENT_PROVIDERS)[number];

/**
 * Coinbase headless on-ramp events, forwarded from the payment-link iframe's
 * postMessage stream (`onramp_api.*`). `orderId` is the create-order id used as
 * the transfer's provider reference. Client events are advisory telemetry only;
 * the signature-verified server-side webhook is the sole settlement authority.
 */
export type CoinbaseRampEvent =
  | { kind: "committed"; orderId: string }
  | { kind: "errored"; orderId: string; reason: string };

export type MoneygramRampEvent =
  | { kind: "signed"; sessionId: string; cryptoTransferId: string }
  | {
      kind: "onramp_completed";
      sessionId: string;
      transactionId: string;
      status: string;
      amount: number;
      referenceNumber?: string;
    }
  | {
      kind: "completed";
      sessionId: string;
      cryptoTransferId: string;
      transactionId: string;
      payoutAmount: number;
      payoutStatus: string;
      referenceNumber?: string;
    }
  | {
      kind: "errored";
      sessionId: string;
      reason: string;
      cryptoTransferId?: string;
      transactionId?: string;
    }
  | { kind: "closed"; sessionId: string };
