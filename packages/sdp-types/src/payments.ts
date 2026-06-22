import type { CustodyWalletAggregate, CustodyWalletTokenBalance } from "./custody";
import type { RampFiatCurrency } from "./generated/ramp-support.generated";
import type { CryptoAssetSymbol, CryptoRailId } from "./payment-rails";
import type { PrivateTransferRequest } from "./private-transfers";
import type { RampProviderId } from "./provider-access";

export interface PaymentsDashboardWallet {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
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
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
}

export interface PaymentWalletPolicyEnvelope {
  data?: {
    policy?: PaymentWalletPolicy;
  };
  error?: {
    message?: string;
  };
}

export type PaymentTransferStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "finalized"
  | "failed"
  | "awaiting_payment"
  | "settling"
  | "completed"
  | "canceled"
  | "expired";

export const SUCCESSFUL_PAYMENT_TRANSFER_STATUSES = [
  "completed",
  "confirmed",
  "finalized",
] as const satisfies readonly PaymentTransferStatus[];

export interface LightsparkGridAmount {
  amount: number;
  currencyCode: string;
  decimals: number;
}

/** MoonPay transaction economics, captured verbatim from a terminal webhook. */
export interface MoonpayRampSettlement {
  provider: "moonpay";
  status: "completed" | "failed";
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
  failureReason?: string;
}

export type RampTransferSettlement = MoonpayRampSettlement | LightsparkRampSettlement;

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
  status: string;
  signature: string | null;
  type?: string;
  direction?: string;
  source?: string;
  destination?: string;
  token?: string;
  amount?: string;
  memo?: string;
  provider?: RampProviderId;
  counterpartyId?: string;
  providerReference?: string;
  deliveryMode?: PaymentRampQuoteDeliveryMode;
  fiatCurrency?: string;
  fiatAmount?: string;
  settlement?: RampTransferSettlement;
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

export interface MagicBlockPreparedPrivateTransfer {
  provider: "magicblock";
  magicBlock: {
    kind: string;
    version: string;
    instructionCount: number;
    requiredSigners: string[];
    validator?: string;
  };
}

export type PreparedPrivateTransfer = MagicBlockPreparedPrivateTransfer;

export interface PaymentTransferRequest {
  projectId?: string;
  source: string;
  destination: string;
  token: string;
  amount: string;
  memo?: string;

  /**
   * Optional private-transfer routing. When omitted, the transfer should use
   * the normal public on-chain transfer path.
   */
  privateTransfer?: PrivateTransferRequest;
}

export interface PaymentTransferEnvelope {
  data?: {
    transfer?: PaymentTransferSummary;
    privateTransfer?: PreparedPrivateTransfer;
  };
  error?: {
    message?: string;
  };
}

export interface PaymentTransferPrepareEnvelope {
  data?: {
    transfer?: PaymentTransferSummary;
    preparedTransaction?: PreparedPaymentTransaction;
    privateTransfer?: PreparedPrivateTransfer;
    simulation?: {
      success: boolean;
      logs: string[];
      unitsConsumed: string | null;
      error: string | null;
    };
  };
  error?: {
    message?: string;
  };
}

export type PaymentSubscriptionPlanStatus = "draft" | "active" | "archived";
export type PaymentSubscriptionStatus =
  | "pending_authorization"
  | "active"
  | "paused"
  | "canceling"
  | "canceled"
  | "expired";
export type PaymentSubscriptionCollectionAttemptStatus =
  | "pending"
  | "processing"
  | "confirmed"
  | "failed"
  | "skipped";

export type PaymentRecurringPaymentStatus =
  | "pending_activation"
  | "activating"
  | "active"
  | "canceling"
  | "resuming"
  | "paused"
  | "canceled"
  | "expired";

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
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecurringPayment {
  id: string;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
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
  sourceWalletId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
  metadataUri?: string;
}

export interface PaymentRecurringPaymentResponse {
  recurringPayment: PaymentRecurringPayment;
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

export interface LightsparkPaymentRampInstruction {
  provider: "lightspark";
  accountOrWalletInfo: {
    accountType: string;
    accountNumber?: string;
    routingNumber?: string;
    paymentRails?: string[];
    reference?: string;
    bankName?: string;
    address?: string;
    assetType?: string;
  };
  instructionsNotes?: string;
  isPlatformAccount?: boolean;
}

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

export interface BvnkPaymentRampInstruction {
  provider: "bvnk";
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

export type PaymentRampInstruction = LightsparkPaymentRampInstruction | BvnkPaymentRampInstruction;

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

export type PaymentRampQuoteDeliveryMode = "manual_instructions" | "hosted" | "session_widget";

export interface PaymentRampQuoteCurrency {
  code: string;
  decimals: number;
  name?: string;
  symbol?: string;
}

interface BasePaymentRampExecution {
  id: string;
  status: PaymentRampExecutionStatus;
  redirectUrl?: string;
  reference?: string;
}

export type LightsparkPaymentRampExecution = BasePaymentRampExecution & {
  provider: "lightspark";
  paymentInstructions?: LightsparkPaymentRampInstruction[];
};

export type BvnkPaymentRampExecution = BasePaymentRampExecution & {
  provider: "bvnk";
  paymentInstructions?: BvnkPaymentRampInstruction[];
};

export type MoonpayPaymentRampExecution = BasePaymentRampExecution & {
  provider: "moonpay";
  paymentInstructions?: never;
};

export type PaymentRampExecution =
  | LightsparkPaymentRampExecution
  | BvnkPaymentRampExecution
  | MoonpayPaymentRampExecution;

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
      provider: "moonpay" | "bvnk";
      deliveryMode: "hosted";
      hostedUrl: string;
    })
  | (BasePaymentRampQuote & {
      provider: "moneygram";
      deliveryMode: "session_widget";
      /** Short-lived (1h) widget session JWT minted from the MoneyGram session API. */
      sessionToken: string;
      sessionId: string;
      widgetUrl: string;
      sdkUrl: string;
    });

export const RAMP_EVENT_PROVIDERS = ["moneygram"] as const;
export type RampEventProvider = (typeof RAMP_EVENT_PROVIDERS)[number];

export type MoneygramRampEvent =
  | { kind: "signed"; sessionId: string; cryptoTransferId: string }
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
