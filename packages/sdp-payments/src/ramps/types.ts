import type {
  Counterparty,
  CounterpartyProviderData,
  PaymentRampEstimate,
  PaymentRampQuote,
  RampCryptoDeposit,
  RampTransferSettlement,
  SdpEnvironment,
} from "@sdp/types";
import type { CounterpartyEntityType } from "@sdp/types/counterparties";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import {
  type CryptoRailId,
  type RampCountrySupport,
  type RampCurrencyLimit,
  type RampPayoutAccountSpec,
  type RampPayoutFieldSpec,
  SOLANA_CRYPTO_RAILS,
} from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import type {
  CounterpartyRequirements,
  PayoutRequirementAccount,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { BvnkComplianceInput } from "./providers/bvnk/provider-data";
import type { LightsparkPurposeOfPayment } from "./providers/lightspark/provider-data";
import type { StripeCustomerInfo } from "./providers/stripe/client";

export type {
  BvnkComplianceInput,
  BvnkCustomerResolution,
  BvnkPaymentRuleResolution,
  BvnkRuleEntity,
} from "./providers/bvnk/provider-data";
export type { LightsparkCustomerResolution } from "./providers/lightspark/client";
export type {
  MuralAccountResolution,
  MuralKycStatus,
  MuralOrganizationResolution,
  MuralPayinMethod,
  MuralTosStatus,
} from "./providers/mural/provider-data";
export type { StripeCustomerInfo } from "./providers/stripe/client";

export const rampPayoutFieldSchema = z
  .object({
    required: z.boolean(),
    pattern: z.string().optional(),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    values: z.array(z.string()).optional(),
    mask: z.string().optional(),
  })
  .strict() satisfies z.ZodType<RampPayoutFieldSpec>;

export const rampPayoutAccountSchema = z
  .object({
    accountType: z.string(),
    rails: z.record(z.string(), z.record(z.string(), rampPayoutFieldSchema)),
  })
  .strict() satisfies z.ZodType<RampPayoutAccountSpec>;

export interface ProviderDirectionSupportSnapshot {
  currencies: Readonly<Record<string, RampCurrencyLimit>>;
  cryptos: readonly CryptoRailId[];
  countrySupport?: RampCountrySupport;
  accounts?: Readonly<Record<string, RampPayoutAccountSpec>>;
  /** Country-agnostic SWIFT payout account, deliverable to any covered country. */
  swiftAccount?: RampPayoutAccountSpec;
}

export interface ProviderRailSupportSnapshot {
  onramp: ProviderDirectionSupportSnapshot;
  offramp: ProviderDirectionSupportSnapshot;
}

const rampCurrencyLimitSchema = z.object({
  min: z.string().nullable(),
  max: z.string().nullable(),
}) satisfies z.ZodType<RampCurrencyLimit>;

const rampCountrySupportSchema = z.discriminatedUnion("coverage", [
  z.object({
    coverage: z.literal("by-country"),
    countries: z.record(z.string(), z.array(z.string())),
  }),
  z.object({
    coverage: z.literal("all-currencies"),
    countries: z.array(z.string()),
  }),
  z.object({ coverage: z.literal("unreported") }),
]) satisfies z.ZodType<RampCountrySupport>;

const providerDirectionSupportSnapshotSchema = z.object({
  currencies: z.record(z.string(), rampCurrencyLimitSchema),
  cryptos: z.array(z.enum(SOLANA_CRYPTO_RAILS)),
  countrySupport: rampCountrySupportSchema.optional(),
  accounts: z.record(z.string(), rampPayoutAccountSchema).optional(),
  swiftAccount: rampPayoutAccountSchema.optional(),
}) satisfies z.ZodType<ProviderDirectionSupportSnapshot>;

export const providerRailSupportSnapshotSchema = z.object({
  onramp: providerDirectionSupportSnapshotSchema,
  offramp: providerDirectionSupportSnapshotSchema,
}) satisfies z.ZodType<ProviderRailSupportSnapshot>;

export interface ProviderRailSupportDistillation {
  snapshot: ProviderRailSupportSnapshot;
  droppedCurrencyCodes: readonly string[];
  droppedCountryCodes: readonly string[];
}

export interface ProviderDeclaredDirectionSupport {
  countrySupport?: RampCountrySupport;
  entityTypes: readonly CounterpartyEntityType[];
}

export interface ProviderDeclaredRailSupport {
  onramp: ProviderDeclaredDirectionSupport;
  offramp: ProviderDeclaredDirectionSupport;
}

export interface RampDiscoveryResponseDump {
  status: number;
  body: unknown;
}

export type RampFetchJson = (
  provider: RampProviderId,
  label: string,
  url: string,
  init?: RequestInit
) => Promise<RampDiscoveryResponseDump>;

export type RampFetchText = (
  provider: RampProviderId,
  label: string,
  url: string
) => Promise<RampDiscoveryResponseDump>;

export type RampDumpWriter = (name: string, payload: RampDiscoveryResponseDump) => Promise<void>;
export type RampRawDumpReader = (relativePath: string) => Promise<unknown>;

export interface RampDiscoveryContext {
  env: Record<string, string | undefined>;
  fetchJson: RampFetchJson;
  fetchText: RampFetchText;
  writeDump: RampDumpWriter;
  readDump: RampRawDumpReader;
  /** Skip the network fetch and distill from the raw dumps already on disk. */
  offline: boolean;
}

export interface RampWebhookValidationContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
  headers: Headers;
  rawBody: string;
  requestUrl?: string;
}

export interface RampOnchainTransfer {
  signature: string;
  sourceAddress?: string;
  destinationAddress?: string;
  amount?: string;
}

interface BaseRampSettlementEvent {
  provider: RampProviderId;
  /** Provider-issued quote/session reference the transfer row was created with — the reconciliation key. */
  reference: string;
  /** Provider-side customer identifier observed on the event, when the provider reports one. */
  providerCustomerId?: string;
  /** Canonical on-chain movement reported by the provider for this ramp transfer. */
  onchain?: RampOnchainTransfer;
}

export type RampSettlementEvent =
  | (BaseRampSettlementEvent & {
      kind: "awaiting_payment";
      /**
       * Off-ramp only: where the provider expects the crypto deposit, when the
       * event reports it. `null` withdraws a previously issued instruction
       * (e.g. the provider requires a requote before accepting the deposit);
       * absent leaves any stored instruction untouched.
       */
      cryptoDeposit?: RampCryptoDeposit | null;
    })
  | (BaseRampSettlementEvent & { kind: "settling" })
  | (BaseRampSettlementEvent & {
      kind: "settled";
      /** Amount the receiving side settled for, in display units — fiat for off-ramp, crypto for on-ramp. */
      receivedAmount?: string;
      settlement?: RampTransferSettlement;
    })
  | (BaseRampSettlementEvent & {
      kind: "failed" | "expired";
      error?: string;
      settlement?: RampTransferSettlement;
    })
  | { provider: RampProviderId; kind: "ignore"; reason: string };

/**
 * Runtime context for quote/execute calls. Providers read their own credentials
 * from `env` keyed by `mode`; the route handler resolves `mode` (it depends on
 * AppContext) and passes plain values so the provider stays AppContext-free.
 */
export interface RampRuntimeContext {
  env: Record<string, string | undefined>;
  mode: SdpEnvironment;
}

export interface RampEstimateOnrampInput {
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  fiatAmount: string;
}

export interface RampEstimateOfframpInput {
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  cryptoAmount: string;
}

export interface RampOnrampQuoteInput {
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  destinationWalletAddress: string;
  /** Handler-resolved id for the provider's external customer reference (MoonPay). */
  externalCustomerId: string;
  /** Handler-reserved SDP payment transfer id for provider correlation. */
  paymentTransferId?: string;
  /** Handler-resolved Grid customer id (Lightspark); resolved via DB + getOrCreateCustomer. */
  customerId?: string;
  /** Handler-resolved purpose-of-payment code stored during counterparty onboarding (Lightspark). */
  purposeOfPayment?: LightsparkPurposeOfPayment;
  bvnkCompliance?: BvnkComplianceInput;
  /** Buyer contact required by Coinbase headless create-order; sourced from the counterparty. */
  email?: string;
  phone?: string;
  /** Browser origin host the Coinbase Apple Pay link renders on (required for iframe embedding). */
  domain?: string;
  /** End-user IP forwarded for the provider's geo/fraud checks (Stripe). */
  customerIpAddress?: string;
  /** Identity pre-fill for the embedded on-ramp widget (Stripe). */
  stripeCustomerInfo?: StripeCustomerInfo;
}

export interface RampOfframpQuoteInput {
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  sourceWalletAddress: string;
  /** Handler-generated SDP payment transfer id for provider caller-defined references. */
  paymentTransferId?: string;
  externalCustomerId: string;
  customerId?: string;
  /** Handler-resolved purpose-of-payment code stored during counterparty onboarding (Lightspark). */
  purposeOfPayment?: LightsparkPurposeOfPayment;
  /** Handler-resolved Grid external payout account id (Lightspark). */
  payoutAccountId?: string;
  /** Handler-provisioned merchant-owned BVNK off-ramp fiat wallet id. */
  bvnkOfframpWalletId?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export type ValidateCounterpartyOptions =
  | {
      direction: "onramp";
      providerData: CounterpartyProviderData;
      cryptoToken?: string;
      fiatCurrency?: RampFiatCurrency;
      destinationWalletAddress?: string;
      providerCustomerReference?: string;
    }
  | {
      direction: "offramp";
      providerData: CounterpartyProviderData;
      cryptoToken?: string;
      fiatCurrency?: RampFiatCurrency;
      cryptoRail?: CryptoRailId;
      payoutAccounts?: readonly PayoutRequirementAccount[];
      providerCustomerReference?: string;
    };

/**
 * Full provider contract: rail discovery plus the runtime quote/execute flow.
 * All HTTP lives behind this; the route handler owns DB interaction and passes
 * pre-resolved inputs.
 */
export interface RampProvider {
  id: RampProviderId;
  declaredRailSupport: ProviderDeclaredRailSupport;
  /**
   * Support-matrix generation hook (ramp-support script only, never runtime):
   * fetches the provider's raw support dumps via `context.fetchJson` and
   * persists them with `context.writeDump` (skipped when `context.offline`),
   * then re-reads the dumps and distills them into the currency/rail snapshot.
   */
  discoverCurrencyAndRails(context: RampDiscoveryContext): Promise<ProviderRailSupportDistillation>;
  estimateOnramp(
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate>;
  estimateOfframp(
    ctx: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate>;
  createOnrampQuote?(
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote>;
  createOfframpQuote(
    ctx: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote>;
  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements;
}
