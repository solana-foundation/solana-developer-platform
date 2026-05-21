import type { CustodyWalletAggregate, CustodyWalletTokenBalance } from "./custody";
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

export interface PaymentTransferEnvelope {
  data?: {
    transfer?: PaymentTransferSummary;
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

export type PaymentRampInstruction = LightsparkPaymentRampInstruction;

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
      provider: Exclude<RampProviderId, "lightspark">;
      paymentInstructions?: never;
    });
