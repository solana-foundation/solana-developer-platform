import type { CustodyWalletAggregate, CustodyWalletTokenBalance } from "./custody";
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
  createdAt?: string;
  updatedAt?: string;
}

export interface PreparedPaymentTransaction {
  serialized: string;
  blockhash: string;
  lastValidBlockHeight?: string;
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

export type BvnkOnboardingStatus = "verification_required" | "verifying" | "provisioning" | "ready";

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
  instructionsNotes?: string;
}

export type PaymentRampInstruction = LightsparkPaymentRampInstruction | BvnkPaymentRampInstruction;

export type PaymentRampQuoteDeliveryMode = "manual_instructions" | "hosted";

interface BasePaymentRampExecution {
  id: string;
  status: PaymentRampExecutionStatus;
  redirectUrl?: string;
  reference?: string;
}

export type PaymentRampExecution =
  | (BasePaymentRampExecution & {
      provider: "lightspark";
      paymentInstructions?: LightsparkPaymentRampInstruction[];
    })
  | (BasePaymentRampExecution & {
      provider: "bvnk";
      paymentInstructions?: BvnkPaymentRampInstruction[];
    })
  | (BasePaymentRampExecution & {
      provider: Exclude<RampProviderId, "lightspark" | "bvnk">;
      paymentInstructions?: never;
    });

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
      /** Final crypto amount received in its smallest unit. */
      totalReceivingAmount?: number;
      /** Fees included in the sending amount, denominated in the fiat currency's smallest unit. */
      feesIncluded?: number;
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
      provider: Exclude<RampProviderId, "lightspark">;
      deliveryMode: "hosted";
      hostedUrl: string;
    });
