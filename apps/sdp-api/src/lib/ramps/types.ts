import type {
  Counterparty,
  CounterpartyProviderData,
  PaymentRampEstimate,
  PaymentRampExecution,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CryptoRailId, FiatCurrencyCode } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { BvnkComplianceInput } from "./providers/bvnk";

export type { BvnkComplianceInput, BvnkRuleEntity } from "./providers/bvnk";

export interface ProviderRampSupport {
  onrampFiats: ReadonlySet<FiatCurrencyCode>;
  onrampCryptos: ReadonlySet<CryptoRailId>;
  offrampFiats: ReadonlySet<FiatCurrencyCode>;
  offrampCryptos: ReadonlySet<CryptoRailId>;
}

export interface MutableProviderRampSupport {
  onrampFiats: Set<FiatCurrencyCode>;
  onrampCryptos: Set<CryptoRailId>;
  offrampFiats: Set<FiatCurrencyCode>;
  offrampCryptos: Set<CryptoRailId>;
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

export type RampDumpWriter = (name: string, payload: RampDiscoveryResponseDump) => Promise<void>;
export type RampDumpReader = <T>(relativePath: string) => Promise<T>;

export interface RampDiscoveryContext {
  env: Record<string, string | undefined>;
  fetchJson: RampFetchJson;
  writeDump: RampDumpWriter;
}

export interface RampWebhookValidationContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
  headers: Headers;
  rawBody: string;
  requestUrl?: string;
}

export interface RampWebhookValidationResult {
  provider: RampProviderId;
  payload: unknown;
}

interface BaseRampSettlementEvent {
  provider: RampProviderId;
  reference: string;
}

export type RampSettlementEvent =
  | (BaseRampSettlementEvent & { kind: "awaiting_payment" })
  | (BaseRampSettlementEvent & { kind: "settling" })
  | (BaseRampSettlementEvent & { kind: "settled" })
  | (BaseRampSettlementEvent & { kind: "failed"; error?: string })
  | (BaseRampSettlementEvent & { kind: "expired"; error?: string })
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
  /** Handler-resolved Grid customer id (Lightspark); resolved via DB + getOrCreateCustomer. */
  customerId?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export interface RampOfframpQuoteInput {
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  sourceWalletAddress: string;
  externalCustomerId: string;
  customerId?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export interface RampExecuteOnrampInput {
  destinationWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export interface RampExecuteOfframpInput {
  sourceWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export interface ValidateCounterpartyOptions {
  direction: RampDirection;
  providerData: CounterpartyProviderData;
}

export interface RampProviderClient {
  id: RampProviderId;
  _discoverRails(context: RampDiscoveryContext): Promise<void>;
  readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport>;
  validateWebhook(context: RampWebhookValidationContext): Promise<RampWebhookValidationResult>;
}

/**
 * Full provider contract: rail discovery + webhook validation (codegen/webhooks)
 * plus the runtime quote/execute flow. All HTTP lives behind this; the route
 * handler owns DB interaction and passes pre-resolved inputs.
 */
export interface RampProvider extends RampProviderClient {
  estimateOnramp(
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate>;
  estimateOfframp(
    ctx: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate>;
  createOnrampQuote(
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote>;
  createOfframpQuote(
    ctx: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote>;
  executeOnramp(
    ctx: RampRuntimeContext,
    input: RampExecuteOnrampInput
  ): Promise<PaymentRampExecution>;
  executeOfframp(
    ctx: RampRuntimeContext,
    input: RampExecuteOfframpInput
  ): Promise<PaymentRampExecution>;
  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements;
}
