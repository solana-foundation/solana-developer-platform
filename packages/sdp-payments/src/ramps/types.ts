import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  Counterparty,
  CounterpartyEntityType,
  CounterpartyProviderData,
} from "@sdp/types/counterparties";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import {
  type CryptoRailId,
  type RampCountrySupport,
  type RampCurrencyLimit,
  SOLANA_CRYPTO_RAILS,
} from "@sdp/types/payment-rails";
import type {
  PaymentRampEstimate,
  PaymentRampQuote,
  RampCryptoDeposit,
  RampDirection,
  RampTransferSettlement,
  RampTransferType,
} from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CollectedFieldData, CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { z } from "zod";

export interface ProviderDirectionSupportSnapshot {
  currencies: Readonly<Record<string, RampCurrencyLimit>>;
  cryptos: readonly CryptoRailId[];
  countrySupport?: RampCountrySupport;
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

/**
 * The keys of the provider account a call runs on: a public identifier and a
 * secret, the pair every ramp account SDP integrates uses. A provider whose
 * account has another shape adds an optional field here.
 */
export interface RampProviderCredentials {
  /** Identifies the account: a publishable key, an API key or a client id. */
  publicKey: string;
  /** Authenticates the account's calls and signs its widget URLs. */
  secretKey: string;
}

/** An account's keys for a mode, or why none can serve it. */
export type RampCredentialsResolution =
  | { ok: true; credentials: RampProviderCredentials }
  | { ok: false; reason: string };

/** The format each of a provider's keys has in one mode. */
export interface RampKeyFormat {
  readonly publicKey: RegExp;
  readonly secretKey: RegExp;
  /** Absent for a provider that only polls and takes no webhooks. */
  readonly webhookSecret?: RegExp;
}

/**
 * A provider's key formats in each mode. Both modes declare the same keys, and
 * a key's format names the mode it runs in wherever the provider's keys do.
 */
export type RampKeyFormats = Readonly<Record<SdpEnvironment, RampKeyFormat>>;

export interface RampDiscoveryContext {
  /** SDP's sandbox keys for the provider, or why it has none. */
  credentials: RampCredentialsResolution;
  fetchJson: RampFetchJson;
  fetchText: RampFetchText;
  writeDump: RampDumpWriter;
  readDump: RampRawDumpReader;
  /** Skip the network fetch and distill from the raw dumps already on disk. */
  offline: boolean;
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
  /** Provider observation time when the provider gives a per-reference ordering field. */
  providerObservedAt?: string;
  /** Provider-side customer identifier observed on the event, when the provider reports one. */
  providerCustomerId?: string;
  /** Provider refund destination, separate from the on-chain sending wallet. */
  refundAddress?: string;
  /** On-chain movement reported by the provider, to verify independently. */
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
  | (BaseRampSettlementEvent & {
      kind: "settling";
      /**
       * Provider-reported amount in the event's receiving currency, stored as
       * an observation without replacing the quote.
       */
      receivedAmount?: string;
    })
  | (BaseRampSettlementEvent & {
      kind: "settled";
      /** Amount the receiving side settled for, in display units — fiat for off-ramp, crypto for on-ramp. */
      receivedAmount?: string;
      /** Off-ramp only: the ISO currency of `receivedAmount`, when the provider names it. */
      receivedCurrency?: string;
      settlement?: RampTransferSettlement;
      /**
       * The crypto rail the provider reports: delivered on-ramp, sold off-ramp.
       * `null` when it names an asset SDP has no rail for; absent when the
       * provider never reports one. Settlement refuses the event unless it is
       * the transfer's own asset.
       */
      deliveredAssetRail?: CryptoRailId | null;
    })
  | (BaseRampSettlementEvent & {
      kind: "failed";
      error?: string;
      settlement?: RampTransferSettlement;
    })
  | (BaseRampSettlementEvent & {
      kind: "expired";
      error?: string;
      settlement?: RampTransferSettlement;
    })
  | {
      provider: RampProviderId;
      kind: "ignore";
      reason: string;
      /**
       * A provider status SDP has no mapping for. Money may be moving, so a
       * status pull holds the transfer for review instead of expiring it.
       */
      unmappedStatus?: string;
    };

/** Provider outcomes the audit ledger records: the sale or buy settled, failed or expired. */
export const RAMP_AUDITED_SETTLEMENT_KINDS = [
  "settled",
  "failed",
  "expired",
] as const satisfies readonly RampSettlementEvent["kind"][];

export type RampAuditedSettlementKind = (typeof RAMP_AUDITED_SETTLEMENT_KINDS)[number];

export function isAuditedRampSettlementKind(
  kind: RampSettlementEvent["kind"]
): kind is RampAuditedSettlementKind {
  return RAMP_AUDITED_SETTLEMENT_KINDS.some((audited) => audited === kind);
}

/**
 * What one provider call runs under: the project's mode, the cluster that mode
 * picks, and the provider account's keys for it. The API resolves all three,
 * so an adapter never sees the process environment (ADR 0008).
 */
export interface RampRuntimeContext {
  mode: SdpEnvironment;
  cluster: SolanaCluster;
  credentials: RampProviderCredentials;
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

/** What the caller knows about the buyer, for a provider widget to pre-fill. */
export interface RampCustomerDetails {
  email?: string;
  firstName?: string;
  lastName?: string;
  dob?: { year: number; month: number; day: number };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

export interface RampOnrampQuoteInput {
  assetRail: CryptoRailId;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  destinationWalletAddress: string;
  /** Handler-resolved id for the provider's external customer reference (MoonPay). */
  externalCustomerId: string;
  /** Handler-reserved SDP payment transfer id for provider correlation. */
  paymentTransferId?: string;
  /** End-user IP forwarded for the provider's geo/fraud checks (Stripe). */
  customerIpAddress?: string;
  /** Identity pre-fill for an embedded on-ramp widget (Stripe). */
  customerDetails?: RampCustomerDetails;
}

export interface RampOfframpQuoteInput {
  assetRail: CryptoRailId;
  fiatCurrency?: RampFiatCurrency;
  cryptoAmount: string;
  sourceWalletAddress: string;
  /** Handler-generated SDP payment transfer id for provider caller-defined references. */
  paymentTransferId?: string;
  externalCustomerId: string;
}

export type ValidateCounterpartyOptions =
  | {
      direction: "onramp";
      providerData: CounterpartyProviderData;
      cryptoToken?: string;
      fiatCurrency?: RampFiatCurrency;
      destinationWalletAddress?: string;
      providerCustomerReference?: string;
      collectedData?: CollectedFieldData;
    }
  | {
      direction: "offramp";
      providerData: CounterpartyProviderData;
      cryptoToken?: string;
      fiatCurrency?: RampFiatCurrency;
      cryptoRail?: CryptoRailId;
      providerCustomerReference?: string;
      collectedData?: CollectedFieldData;
    };

/** What the provider answered when SDP canceled the sale it holds for a canceled transfer. */
export type RampProviderCancelOutcome = "canceled" | "not_found" | "not_cancelable";

/** The stored transfer a status lookup asks its provider about. */
export interface RampTransferLookup {
  /** SDP's transfer id, which a provider that takes a caller reference stores with it. */
  transferId: string;
  rampType: RampTransferType;
  /** The provider reference the transfer row holds; null until one is bound. */
  providerReference: string | null;
}

/** The members a provider needs to run an on-ramp. */
export interface RampOnrampMembers {
  estimateOnramp: (
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ) => Promise<PaymentRampEstimate>;
  createOnrampQuote: (
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ) => Promise<PaymentRampQuote>;
}

/** The members a provider needs to run an off-ramp. */
export interface RampOfframpMembers {
  estimateOfframp: (
    ctx: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ) => Promise<PaymentRampEstimate>;
  createOfframpQuote: (
    ctx: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ) => Promise<PaymentRampQuote>;
}

/** Each direction's members, by direction. */
export interface RampDirectionMembers {
  onramp: RampOnrampMembers;
  offramp: RampOfframpMembers;
}

/** The member names each direction needs, so `supportsRampDirection` and the contract suite agree. */
export const RAMP_DIRECTION_MEMBERS = {
  onramp: ["estimateOnramp", "createOnrampQuote"],
  offramp: ["estimateOfframp", "createOfframpQuote"],
} as const satisfies {
  readonly [Direction in RampDirection]: readonly (keyof RampDirectionMembers[Direction])[];
};

/**
 * Full provider contract: rail discovery plus the runtime quote/execute flow.
 * All HTTP lives behind this; the route handler owns DB interaction and passes
 * pre-resolved inputs. Members are function-typed, so an implementation is
 * checked strictly. A provider that does not run a direction omits that
 * direction's members.
 *
 * @typeParam Event - The settlement events its status pull answers, as its
 * webhook processor reads them.
 */
export interface RampProvider<Event extends RampSettlementEvent = RampSettlementEvent>
  extends Partial<RampOnrampMembers>,
    Partial<RampOfframpMembers> {
  readonly id: RampProviderId;
  /** The provider's name as people read it, in SDP's messages. */
  readonly label: string;
  readonly declaredRailSupport: ProviderDeclaredRailSupport;
  /**
   * The format of every key the provider's account has, by mode. The keys a
   * provider declares here are the managed keys SDP holds for it, and a key
   * that doesn't fit its mode never makes a request.
   */
  readonly keyFormats: RampKeyFormats;
  /** Optional webhook contract. Ingress verifies signed bytes before persisting;
   * parsing is pure and runs from the durable inbox after acknowledgement. */
  webhook?: RampProviderWebhook;
  /**
   * Status pull, for the sweep that recovers missed webhooks. Answers the
   * events the provider's webhook would carry for each transaction it holds
   * for the transfer, oldest update first, and none when it holds no
   * transaction. Throws when SDP could not ask, so a failure never reads as
   * absence.
   */
  fetchTransferStatus: (
    ctx: RampRuntimeContext,
    lookup: RampTransferLookup
  ) => Promise<readonly Event[]>;
  /**
   * Optional: cancels the sale the provider holds under SDP's transfer id,
   * once SDP has canceled its own record. `not_found` when the customer never
   * confirmed a sale; throws when SDP could not ask.
   */
  cancelOfframpSale?: (
    ctx: RampRuntimeContext,
    transferId: string,
    signal?: AbortSignal
  ) => Promise<RampProviderCancelOutcome>;
  /**
   * Support-matrix generation hook (ramp-support script only, never runtime):
   * fetches the provider's raw support dumps via `context.fetchJson` and
   * persists them with `context.writeDump` (skipped when `context.offline`),
   * then re-reads the dumps and distills them into the currency/rail snapshot.
   */
  discoverCurrencyAndRails: (
    context: RampDiscoveryContext
  ) => Promise<ProviderRailSupportDistillation>;
  validateCounterparty: (
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ) => CounterpartyRequirements;
}

/**
 * Whether `provider` runs `direction`: it has every member the direction
 * needs. Narrows the provider to those members.
 */
export function supportsRampDirection<Direction extends RampDirection>(
  provider: RampProvider,
  direction: Direction
): provider is RampProvider & RampDirectionMembers[Direction] {
  return RAMP_DIRECTION_MEMBERS[direction].every((member) => provider[member] !== undefined);
}

export interface RampProviderWebhook<Event = unknown> {
  readonly signature: {
    readonly header: string;
    readonly encoding: "hex" | "base64";
    readonly signedPayload: "timestamp-prefixed" | "raw-body";
  };
  /** A provider-issued delivery id only; null when the provider supplies none. */
  eventId(rawBody: string): string | null;
  parse(rawBody: string, environment?: SdpEnvironment): Event;
}
