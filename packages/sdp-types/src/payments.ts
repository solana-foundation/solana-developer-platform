import type { Address } from "@solana/addresses";
import { z } from "zod";
import type {
  CustodyProvider,
  CustodyWalletAggregate,
  CustodyWalletTokenBalance,
  StagedProviderRefusalReason,
} from "./custody";
import type { RampFiatCurrency } from "./generated/ramp.generated";
import type { CryptoAssetSymbol, CryptoRailId, CryptoRailNetwork } from "./payment-rails";
import {
  isPrivateChannelDepositTerminal,
  PRIVATE_CHANNEL_TRANSACTION_STATUSES,
  type PrivateChannelTransferStatus,
} from "./private-channels";
import type { PersistedRampProviderId, RampProviderId } from "./provider-access";
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
 * apply or the replay job settles it, `discharged` while the outcome is
 * retained, `archived` after retention, and `failed` once an operator has to
 * look.
 */
export const RAMP_WEBHOOK_EVENT_STATUSES = ["pending", "failed", "discharged", "archived"] as const;

export type RampWebhookEventStatus = (typeof RAMP_WEBHOOK_EVENT_STATUSES)[number];

export const RAMP_WEBHOOK_BUSINESS_OUTCOMES = [
  "applied",
  "ignored",
  "unmatched",
  "refused",
] as const;
export type RampWebhookBusinessOutcome = (typeof RAMP_WEBHOOK_BUSINESS_OUTCOMES)[number];

export const RAMP_WEBHOOK_REFUSAL_REASONS = [
  "environment_mismatch",
  "provider_mismatch",
  "transfer_type_mismatch",
  "asset_mismatch",
  "settled_after_cancel",
  "provider_reference_conflict",
  "moonpay_attempt_revived",
  "moonpay_failure_after_funding",
  "moonpay_terminal_conflict",
  "moonpay_sell_failed",
] as const;
export type RampWebhookRefusalReason = (typeof RAMP_WEBHOOK_REFUSAL_REASONS)[number];

export type RampWebhookProcessResult =
  | { outcome: Exclude<RampWebhookBusinessOutcome, "refused">; reason?: never }
  | { outcome: "refused"; reason: RampWebhookRefusalReason };

export const RAMP_WEBHOOK_APPLY_OUTCOMES = [
  ...RAMP_WEBHOOK_BUSINESS_OUTCOMES,
  "discarded",
  "invalid",
  "retryable_error",
] as const;
export type RampWebhookApplyOutcome = (typeof RAMP_WEBHOOK_APPLY_OUTCOMES)[number];
export type RampWebhookDischargeOutcome = Extract<
  RampWebhookApplyOutcome,
  "applied" | "ignored" | "discarded"
>;
export type RampWebhookFailureOutcome = Exclude<
  RampWebhookApplyOutcome,
  RampWebhookDischargeOutcome
>;

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

/** Statuses in which a signed transfer may persist or begin its submission. */
export const SIGNED_TRANSFER_SUBMISSION_STATUSES = {
  standard: ["processing"],
  offramp: ["processing", "settling"],
} as const satisfies Record<"standard" | "offramp", readonly PaymentTransferStatus[]>;

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

/** Ramp transfer statuses that are not terminal; a settlement or cancellation can still land. */
export const NON_TERMINAL_RAMP_TRANSFER_STATUSES = PAYMENT_TRANSFER_STATUSES.filter(
  (status) => !RAMP_TRANSFER_STATUS_TERMINAL[status]
);

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

/** Whether a ramp transfer in each status can still be funded by a pay-in: only before it settles. */
export const RAMP_TRANSFER_STATUS_FUNDABLE = {
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

/** Reports whether a ramp transfer in the given status can still receive a pay-in. */
export function isFundableRampTransferStatus(status: PaymentTransferStatus): boolean {
  return RAMP_TRANSFER_STATUS_FUNDABLE[status];
}

/** The statuses an on-ramp pay-in can still settle a transfer from. */
export const FUNDABLE_RAMP_TRANSFER_STATUSES = PAYMENT_TRANSFER_STATUSES.filter(
  (status) => RAMP_TRANSFER_STATUS_FUNDABLE[status]
);

/** One legal ramp transfer status change: where it may start, where it lands, and the ramp types it applies to. */
export interface RampTransferTransition {
  readonly from: readonly PaymentTransferStatus[];
  readonly to: PaymentTransferStatus;
  readonly types: readonly RampTransferType[];
}

/**
 * Every status a ramp row is open in, plus `expired`, which a provider
 * observation proves was premature. `confirmed` and `finalized` belong to wallet
 * sends; no writer puts a ramp row there.
 */
export const PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES = [
  "pending",
  "processing",
  "awaiting_payment",
  "settling",
  "expired",
] as const satisfies readonly PaymentTransferStatus[];

/** The open ones among them, which a provider status pull checks; `expired` has its own queue. */
export const OPEN_PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES =
  PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES.filter((status) => status !== "expired");

/** A MoonPay attempt with no SDP deposit claim can safely stop taking payment. */
const MOONPAY_UNCLAIMED_TRANSFER_STATUSES = [
  "pending",
  "awaiting_payment",
  "expired",
] as const satisfies readonly PaymentTransferStatus[];

/**
 * Legal ramp transfer status changes, by name. `transitionRampTransfer` reads
 * the source statuses from here, never from its caller, so an illegal
 * transition matches zero rows, the same answer a lost race gives. No terminal
 * status is a source except `expired`. Every writer is listed in the API's
 * `ramp-transfer-transitions.test.ts`.
 */
export const RAMP_TRANSFER_TRANSITIONS = {
  // A provider may issue a new deposit wallet while still awaiting payment
  // (MoonPay does on sale re-confirmation), so the self-transition must land.
  provider_awaiting_payment: {
    from: ["pending", "awaiting_payment", "expired"],
    to: "awaiting_payment",
    types: RAMP_TRANSFER_TYPES,
  },
  provider_settling: {
    from: PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES,
    to: "settling",
    types: RAMP_TRANSFER_TYPES,
  },
  provider_settled: {
    from: PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES,
    to: "settling",
    types: RAMP_TRANSFER_TYPES,
  },
  // A provider's word is not delivery. Only the chain verifier may complete.
  delivery_verified: {
    from: ["settling"],
    to: "completed",
    types: RAMP_TRANSFER_TYPES,
  },
  provider_failed: {
    from: PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES,
    to: "failed",
    types: RAMP_TRANSFER_TYPES,
  },
  // A failed MoonPay checkout attempt releases its transaction reference so
  // the same transfer can be retried. The caller separately guards funding.
  moonpay_attempt_failed: {
    from: MOONPAY_UNCLAIMED_TRANSFER_STATUSES,
    to: "awaiting_payment",
    types: ["onramp"],
  },
  // A failed sale closes its deposit instruction before another deposit can
  // claim it. A deposit already claimed stays open for reconciliation.
  moonpay_sell_failed: {
    from: MOONPAY_UNCLAIMED_TRANSFER_STATUSES,
    to: "failed",
    types: ["offramp"],
  },
  // A sale failed while its deposit is claimed: the claim stays open, since the
  // deposit may still land, but holds the failure so releasing the claim after
  // a failed send can't reopen the sale.
  moonpay_sell_failed_while_claimed: {
    from: ["processing"],
    to: "processing",
    types: ["offramp"],
  },
  // Not from `settling`: a stale redelivered expiry must not undo a transfer
  // another event already revived.
  provider_expired: {
    from: ["pending", "awaiting_payment"],
    to: "expired",
    types: RAMP_TRANSFER_TYPES,
  },
  // SDP's own verdict from provider silence (HOO-2040): no provider activity
  // past the abandonment horizon. Never from `processing` or `settling`, where
  // funds may be moving; a later provider observation revives it.
  checkout_abandoned: {
    from: ["pending", "awaiting_payment"],
    to: "expired",
    types: RAMP_TRANSFER_TYPES,
  },

  canceled: {
    from: CANCELABLE_RAMP_TRANSFER_STATUSES,
    to: "canceled",
    types: RAMP_TRANSFER_TYPES,
  },
  // A quote that creates its row before calling the provider (MoonPay) records
  // the provider's answer on that pending row.
  quote_issued: {
    from: ["pending"],
    to: "pending",
    types: RAMP_TRANSFER_TYPES,
  },
  quote_failed: {
    from: ["pending"],
    to: "failed",
    types: RAMP_TRANSFER_TYPES,
  },
  offramp_deposit_claimed: {
    from: ["awaiting_payment"],
    to: "processing",
    types: ["offramp"],
  },
  // A landed deposit waits on the provider's payout, so it settles instead of
  // confirming like a wallet send.
  offramp_deposit_confirmed: {
    from: ["processing"],
    to: "settling",
    types: ["offramp"],
  },
  offramp_deposit_failed: {
    from: ["processing"],
    to: "failed",
    types: ["offramp"],
  },
  // A deposit that failed before SDP recorded any signed bytes moved nothing,
  // so the sale goes back to awaiting its deposit.
  offramp_deposit_released: {
    from: ["processing"],
    to: "awaiting_payment",
    types: ["offramp"],
  },
} as const satisfies Record<string, RampTransferTransition>;

export type RampTransferTransitionId = keyof typeof RAMP_TRANSFER_TRANSITIONS;

/** The transition a funded off-ramp deposit takes for the status a wallet send would land on. */
export const OFFRAMP_DEPOSIT_OUTCOME_TRANSITIONS = {
  confirmed: "offramp_deposit_confirmed",
  finalized: "offramp_deposit_confirmed",
  failed: "offramp_deposit_failed",
} as const satisfies Record<TransferChainVerdictStatus, RampTransferTransitionId>;

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

/** The commitment a transfer's in-request wait reaches, which is also the status it lands on. */
export type TransferLandingStatus = Exclude<TransferChainVerdictStatus, "failed">;

/**
 * The commitment a transfer request waits for before it answers. A wallet send
 * reports success only once the cluster finalizes it; a funded off-ramp
 * deposit still settles at confirmed, since the provider's payout decides its
 * outcome.
 *
 * @param type - The transfer's type.
 * @returns The status the transfer lands on when its wait succeeds.
 */
export function transferLandingStatus(type: PaymentTransferType): TransferLandingStatus {
  return isRampTransferType(type) ? "confirmed" : "finalized";
}

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

export type RampTransferSettlement = MoonpayRampSettlement;

/** Where an off-ramp sale expects the crypto deposit, reported by the provider while awaiting payment. */
export interface RampCryptoDeposit {
  /** Provider-owned wallet address the crypto must be sent to. */
  destinationAddress: string;
  /** Crypto amount the provider expects, in display units. */
  amount: string;
}

/** What an off-ramp's provider reports paying out once it settles the sale. SDP cannot verify a bank payout. */
export interface RampFiatPayout {
  /** Fiat paid out, in display units. Differs from the quoted `fiatAmount` when the provider re-prices. */
  amount: string;
  /** ISO currency of `amount`, as the provider reports it. */
  currency: string;
  /** When the provider reported the payout. */
  reportedAt?: string;
}

/** Why SDP holds a provider-settled ramp instead of completing it. */
export const RAMP_DELIVERY_MISMATCH_REASONS = [
  /** The provider's report contradicts SDP's record of the ramp (its wallet, deposit or amount). */
  "provider_report_mismatch",
  /** The delivery transaction failed onchain. */
  "transaction_failed",
  /** The transaction landed before SDP created the transfer, so it delivered something else. */
  "predates_transfer",
  /** The transaction moved none of the quoted asset to the quoted wallet. */
  "not_delivered",
  /** It delivered a different amount than the provider reported, or less than quoted. */
  "amount_mismatch",
  /** No finalized transaction carries the reported signature an hour after the report. */
  "transaction_not_found",
] as const;
export type RampDeliveryMismatchReason = (typeof RAMP_DELIVERY_MISMATCH_REASONS)[number];

/**
 * Holds that record only missing evidence (the RPC found no transaction). The
 * verifier keeps checking, and a later read that finds the delivery completes
 * the transfer and clears the hold.
 */
export const RAMP_DELIVERY_RETRYABLE_MISMATCH_REASONS = [
  "transaction_not_found",
] as const satisfies readonly RampDeliveryMismatchReason[];

/**
 * A provider-settled ramp the chain contradicts. SDP holds it in `settling`
 * for review instead of completing it, until the provider reports again.
 */
export interface RampDeliveryMismatch {
  reason: RampDeliveryMismatchReason;
  /** When SDP's delivery check reached this verdict. */
  checkedAt: string;
  /** What the provider reported delivering, in display units, when it said. */
  reportedAmount?: string;
  /** What the chain shows the quoted wallet received, in display units. */
  observedAmount?: string;
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
  /** A retired provider's transfers still read, as stored. */
  provider?: PersistedRampProviderId;
  counterpartyId?: string;
  counterpartyDisplayName?: string;
  providerReference?: string;
  fireblocks?: {
    transactionId: string | null;
    status: string;
    subStatus: string | null;
  };
  deliveryMode?: PaymentRampQuoteDeliveryMode;
  fiatCurrency?: string;
  fiatAmount?: string;
  settlement?: RampTransferSettlement;
  cryptoDeposit?: RampCryptoDeposit;
  fiatPayout?: RampFiatPayout;
  deliveryMismatch?: RampDeliveryMismatch;
  /** When SDP confirmed the transfer; a ramp is confirmed once its delivery is verified onchain. */
  confirmedAt?: string;
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

export const PAYMENT_TRANSFER_BATCH_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "failed",
  "partially_failed",
  "archived",
] as const;
export type PaymentTransferBatchStatus = (typeof PAYMENT_TRANSFER_BATCH_STATUSES)[number];

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
/**
 * A recurring payment that collects, or will once its activation, update or
 * resume in flight finishes, or once a cancel in flight fails back to active:
 * revoke-and-cancel must see all of them, or one mid-way would become active
 * after the revoke that was meant to stop it.
 */
export const LIVE_RECURRING_PAYMENT_STATUSES = [
  ...COLLECTABLE_RECURRING_PAYMENT_STATUSES,
  "activating",
  "updating",
  "canceling",
  "resuming",
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
/**
 * The collection attempts that answer a keyed collect (HOO-1918): a live one,
 * as migration 0135's unique index covers. A failed or skipped attempt answers
 * nothing, so the same key runs again.
 */
export const COLLECTION_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY =
  COLLECTION_ATTEMPT_STATUSES_BLOCKING_NEW_CYCLE;
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
/**
 * The activation, lifecycle and update attempts that answer a keyed request
 * (HOO-1918): every one but a failed attempt, as migration 0135's unique
 * indexes cover. A failed attempt answers nothing, so the same key runs again.
 */
export const RECURRING_PAYMENT_ATTEMPT_STATUSES_ANSWERING_IDEMPOTENCY_KEY = [
  "processing",
  "confirmed",
] as const satisfies readonly PaymentRecurringPaymentAttemptStatus[];
/**
 * A revoke of a wallet's per-mint Subscriptions authority (HOO-2210): the
 * revoke-subscription-authorities cron's row (migration 0153).
 */
export const SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES = [
  "processing",
  "confirmed",
  "failed",
] as const;
export type SubscriptionAuthorityRevocationStatus =
  (typeof SUBSCRIPTION_AUTHORITY_REVOCATION_STATUSES)[number];
/** A revoke in these holds the wallet: activation, update and resume wait for it. */
export const SUBSCRIPTION_AUTHORITY_REVOCATION_HOLDING_STATUSES = [
  "processing",
] as const satisfies readonly SubscriptionAuthorityRevocationStatus[];
/**
 * A recurring payment in these no longer needs its authority once its last
 * billing period is over; every other status does, or may again.
 */
export const RECURRING_PAYMENT_STATUSES_RELEASING_AUTHORITY = [
  "canceled",
  "expired",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
/** A subscription in these no longer needs its authority once its last billing period is over. */
export const PAYMENT_SUBSCRIPTION_STATUSES_RELEASING_AUTHORITY = [
  "canceled",
  "expired",
] as const satisfies readonly PaymentSubscriptionStatus[];
/**
 * A subscription in these was recorded before its authorization was sent. It stops holding its
 * authority once nothing can still authorize it: no live recurring payment names it and no update
 * in flight is creating it (a failed attempt has proven its authorization never landed).
 */
export const PAYMENT_SUBSCRIPTION_STATUSES_AWAITING_AUTHORIZATION = [
  "pending_authorization",
] as const satisfies readonly PaymentSubscriptionStatus[];
/**
 * A recurring payment in these may be about to use its wallet's authority before it records the
 * authority on its row, so nothing on that wallet is revoked meanwhile.
 */
export const RECURRING_PAYMENT_STATUSES_CLAIMING_AUTHORITY = [
  "activating",
  "updating",
  "resuming",
] as const satisfies readonly PaymentRecurringPaymentStatus[];
export function isInFlightRecurringPaymentAttemptStatus(
  status: PaymentRecurringPaymentAttemptStatus
): boolean {
  return IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES.some((candidate) => candidate === status);
}
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

/**
 * Every status a money route's answer can show for the movement it made: a
 * transfer, a batch, a recurring schedule, a collection attempt, or a
 * private-channel transfer.
 */
export type MoneyMovementStatus =
  | PaymentTransferStatus
  | PaymentTransferBatchStatus
  | PaymentRecurringPaymentStatus
  | PaymentSubscriptionCollectionAttemptStatus
  | PrivateChannelTransferStatus;

const MONEY_MOVEMENT_STATUSES: ReadonlySet<string> = new Set<MoneyMovementStatus>([
  ...PAYMENT_TRANSFER_STATUSES,
  ...PAYMENT_TRANSFER_BATCH_STATUSES,
  ...PAYMENT_RECURRING_PAYMENT_STATUSES,
  ...PAYMENT_SUBSCRIPTION_COLLECTION_ATTEMPT_STATUSES,
  ...PRIVATE_CHANNEL_TRANSACTION_STATUSES,
]);

/** Whether a status a response carries is one of {@link MoneyMovementStatus}. */
export function isMoneyMovementStatus(status: string): status is MoneyMovementStatus {
  return MONEY_MOVEMENT_STATUSES.has(status);
}

/**
 * Statuses that mean a money movement is still under way (APE-461): a
 * transfer not yet in a terminal or successful status (pending, processing,
 * awaiting payment, settling; a batch and a collection attempt use the same
 * in-flight names), a recurring schedule mid-transition (the statuses the cron
 * recovers, plus the update's processing status), and a private-channel
 * transfer without a verdict (APE-593). While an answer shows one, a client
 * keeps the request's Idempotency-Key.
 */
export const NON_FINAL_MONEY_MOVEMENT_STATUSES: readonly MoneyMovementStatus[] = [
  ...new Set<MoneyMovementStatus>([
    ...NON_TERMINAL_RAMP_TRANSFER_STATUSES.filter(
      (status) => !isSuccessfulPaymentTransferStatus(status)
    ),
    ...RECURRING_PAYMENT_STATUSES_RECOVERABLE_BY_CRON,
    RECURRING_PAYMENT_UPDATE_TRANSITION.processingStatus,
    ...PRIVATE_CHANNEL_TRANSACTION_STATUSES.filter(
      (status) => !isPrivateChannelDepositTerminal(status)
    ),
  ]),
];

/** Whether a money movement in this status is still under way ({@link NON_FINAL_MONEY_MOVEMENT_STATUSES}). */
export function isMoneyMovementInFlight(status: MoneyMovementStatus): boolean {
  return NON_FINAL_MONEY_MOVEMENT_STATUSES.includes(status);
}

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

export const PAYMENT_REQUEST_STATUSES = [
  "awaiting_payment",
  "paid",
  "canceled",
  "expired",
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export interface PaymentRequestLifecycleEvent {
  status: PaymentRequestStatus;
  at: string;
}

/**
 * A payment request as reads return it. It carries no link token: that is a
 * bearer secret, returned only by {@link CreatedPaymentRequest} and
 * {@link PaymentRequestLink} (APE-849).
 */
export interface PaymentRequest {
  id: string;
  organizationId: string;
  projectId: string | null;
  walletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  reference: string;
  status: PaymentRequestStatus;
  expiresAt: string | null;
  fulfilledByTransferId: string | null;
  paidLate?: boolean;
  lastCheckedAt?: string | null;
  canceledBy: string | null;
  lifecycle: PaymentRequestLifecycleEvent[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The create response: the record plus the token behind its hosted `/pay/{publicToken}` link. */
export interface CreatedPaymentRequest extends PaymentRequest {
  publicToken: string;
}

/**
 * `GET /v1/payments/requests/{id}/link` (`payment_requests.manage`): the
 * request's link token.
 */
export interface PaymentRequestLink {
  id: string;
  publicToken: string;
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

export type PaymentRampInstruction = never;

export const RAMP_DIRECTIONS = ["onramp", "offramp"] as const;

export type RampDirection = (typeof RAMP_DIRECTIONS)[number];

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
  /** On-ramp: the fiat that buys the crypto, the provider's fees apart. Off-ramp: the payout. */
  fiatAmount: string;
  cryptoAmount: string;
  /** What one unit of the crypto costs in the fiat, in both directions. */
  exchangeRate: string;
  /** On-ramp only: what the customer pays in all, `fiatAmount` plus the provider's fees. */
  totalFiatAmount?: string;
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

/** The provider's estimate call failed. */
export interface RampProviderEstimateFailure {
  provider: RampProviderId;
  status: "error";
  error: string;
}

/**
 * The staged-provider rule refused the provider for the project, so it was
 * never called: a refusal outcome, not a fault. `reason` is the rule's
 * machine-readable verdict, the same one its 403 carries as `details.reason`.
 */
export interface RampProviderEstimateRefusal {
  provider: RampProviderId;
  status: "error";
  error: string;
  reason: StagedProviderRefusalReason;
}

/** Why a provider refuses an amount for a pair. */
export const RAMP_AMOUNT_LIMIT_REASONS = ["amount_below_minimum", "amount_above_maximum"] as const;
export type RampAmountLimitReason = (typeof RAMP_AMOUNT_LIMIT_REASONS)[number];

/** The bound an amount crossed, in the currency the amount was given in. */
export interface RampAmountLimit {
  amount: string;
  currency: string;
}

/** The provider takes no such amount for this pair: a refusal with its bound, not a fault. */
export interface RampProviderEstimateOutOfRange {
  provider: RampProviderId;
  status: "error";
  error: string;
  reason: RampAmountLimitReason;
  limit: RampAmountLimit;
}

export type RampProviderEstimateResult =
  | RampProviderEstimateSuccess
  | RampProviderEstimateUnsupported
  | RampProviderEstimateFailure
  | RampProviderEstimateRefusal
  | RampProviderEstimateOutOfRange;

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
  rampsMemo?: Record<string, string>;
}

interface PaymentOfframpQuoteRequestBase {
  counterpartyId: string;
  sourceCustodyWalletId: string;
  assetRail: CryptoRailId;
  cryptoAmount: string;
  rampsMemo?: Record<string, string>;
}

export type PaymentOfframpQuoteRequest = PaymentOfframpQuoteRequestBase & {
  provider: RampProviderId;
  fiatCurrency?: RampFiatCurrency;
};

export type PaymentRampQuoteDeliveryMode = "manual_instructions" | "hosted" | "session_widget";

interface BasePaymentRampQuote {
  id: string;
  provider: RampProviderId;
  /** Every provider's quote opens its transfer before the customer pays. */
  status: "pending";
  deliveryMode: PaymentRampQuoteDeliveryMode;
}

export type PaymentRampQuote =
  | (BasePaymentRampQuote & {
      provider: "moonpay";
      deliveryMode: "hosted";
      hostedUrl: string;
    })
  | (BasePaymentRampQuote & {
      provider: "stripe";
      deliveryMode: "session_widget";
      clientSecret: string;
      sessionId: string;
      publishableKey: string;
      redirectUrl?: string;
    });
