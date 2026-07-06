import type { Address } from "@solana/addresses";
import type { CustodyWalletAggregate, CustodyWalletTokenBalance } from "./custody";
import type { RampFiatCurrency } from "./generated/ramp-support.generated";
import type { CryptoAssetSymbol, CryptoRailId, CryptoRailNetwork } from "./payment-rails";
import type {
  PolicyDefaultAction,
  PolicyProfileStatus,
  PolicyProviderSyncStatus,
  PolicyRule,
} from "./policy";
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
  defaultAction?: PolicyDefaultAction;
  rules?: PolicyRule[];
  controlProfile?: PaymentWalletControlProfileSummary;
}

export interface PaymentWalletControlProfileSummary {
  id: string;
  status: PolicyProfileStatus;
  activeRevisionId: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
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
  source: string;
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
  sourceWalletId: string;
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
  | "updating"
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
  sourceWalletId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
  metadataUri?: string;
}

export interface UpdatePaymentRecurringPaymentRequest {
  sourceWalletId?: string;
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
      provider: "moonpay" | "bvnk" | "coinbase";
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

export const RAMP_EVENT_PROVIDERS = ["moneygram", "coinbase"] as const;
export type RampEventProvider = (typeof RAMP_EVENT_PROVIDERS)[number];

/**
 * Coinbase headless on-ramp events, forwarded from the payment-link iframe's
 * postMessage stream (`onramp_api.*`). `orderId` is the create-order id used as
 * the transfer's provider reference. Client events are provisional and only
 * advance the transfer to non-terminal states; the server-side webhook is the
 * settlement authority — it alone completes the transfer, carrying the actual
 * delivered crypto amount, which a client-set terminal status would block.
 */
export type CoinbaseRampEvent =
  | { kind: "committed"; orderId: string }
  | { kind: "errored"; orderId: string; reason: string };

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
