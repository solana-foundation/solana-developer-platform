import type {
  Counterparty,
  CounterpartyProviderData,
  PaymentRampEstimate,
  PaymentRampQuote,
  RampTransferSettlement,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { BvnkComplianceInput } from "./providers/bvnk/provider-data";

export type {
  BvnkComplianceInput,
  BvnkCustomerResolution,
  BvnkPaymentRuleResolution,
  BvnkRuleEntity,
} from "./providers/bvnk/provider-data";
export type { LightsparkCustomerResolution } from "./providers/lightspark/client";

export interface ProviderRampSupport {
  onrampFiats: ReadonlySet<RampFiatCurrency>;
  onrampCryptos: ReadonlySet<CryptoRailId>;
  offrampFiats: ReadonlySet<RampFiatCurrency>;
  offrampCryptos: ReadonlySet<CryptoRailId>;
}

export interface MutableProviderRampSupport {
  onrampFiats: Set<RampFiatCurrency>;
  onrampCryptos: Set<CryptoRailId>;
  offrampFiats: Set<RampFiatCurrency>;
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

interface BaseRampSettlementEvent {
  provider: RampProviderId;
  reference: string;
}

export type RampSettlementEvent =
  | (BaseRampSettlementEvent & { kind: "awaiting_payment" })
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
  /** Handler-resolved Grid customer id (Lightspark); resolved via DB + getOrCreateCustomer. */
  customerId?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
  /** Buyer contact required by Coinbase headless create-order; sourced from the counterparty. */
  email?: string;
  phone?: string;
  /** Browser origin host the Coinbase Apple Pay link renders on (required for iframe embedding). */
  domain?: string;
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
  /** Handler-resolved Grid external payout account id (Lightspark). */
  payoutAccountId?: string;
  /** Handler-provisioned merchant-owned BVNK off-ramp fiat wallet id. */
  bvnkOfframpWalletId?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
}

export interface ValidateCounterpartyOptions {
  direction: RampDirection;
  providerData: CounterpartyProviderData;
  cryptoToken?: string;
  fiatCurrency?: RampFiatCurrency;
  destinationWalletAddress?: string;
}

/**
 * Full provider contract: rail discovery plus the runtime quote/execute flow.
 * All HTTP lives behind this; the route handler owns DB interaction and passes
 * pre-resolved inputs.
 */
export interface RampProvider {
  id: RampProviderId;
  _discoverRails(context: RampDiscoveryContext): Promise<void>;
  readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport>;
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
