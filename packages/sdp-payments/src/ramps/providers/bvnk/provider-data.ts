import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import type { CryptoAssetSymbol } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { type CounterpartyRow, SDP_COUNTERPARTY_ID_PATTERN } from "../../../counterparty";
import { badRequest, internalError } from "../../../errors";
import { hashString } from "../../../hash";
import { readRecord } from "../../../json";
import { readyCounterparty } from "../../requirements";
import type { BvnkCustomer, BvnkCustomerStatus } from "./schemas";

/** The address keys BVNK's rule validation accepts for a beneficiary entity. */
export interface BvnkRuleEntityAddress {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  /** ISO 3166-2 region/state code; BVNK requires it for US beneficiaries. */
  region?: string;
  postCode?: string;
  /** ISO 3166-1 alpha-2 country; BVNK rule validation rejects a blank `country`. */
  country: string;
}

export type BvnkEntityType = "INDIVIDUAL" | "COMPANY";

/**
 * Beneficiary entity accepted by a BVNK on-ramp payment rule. INDIVIDUAL
 * requires the person fields; COMPANY keeps legalName/registrationNumber.
 */
export type BvnkRuleEntity =
  | {
      type: "INDIVIDUAL";
      customerIdentifier: string;
      relationshipType: "SELF_OWNED" | "THIRD_PARTY";
      firstName: string;
      lastName: string;
      dateOfBirth: string;
      address: BvnkRuleEntityAddress;
    }
  | {
      type: "COMPANY";
      customerIdentifier: string;
      relationshipType: "SELF_OWNED" | "THIRD_PARTY";
      legalName: string;
      registrationNumber: string;
    };

/**
 * Builds the INDIVIDUAL beneficiary entity for a BVNK on-ramp payment rule from
 * the v1 customer GET's `individual.person` block. SDP persists no PII, so the
 * rule create reads it JIT from BVNK and the entity is never stored.
 *
 * @param customer - Typed v1 customer response from the v1 customer GET.
 * @returns The rule entity mapped onto BVNK's accepted address keys.
 * @throws SdpPaymentsError with `INTERNAL_ERROR` when the customer has no
 * individual details to build the entity from.
 */
export function bvnkRuleEntityFromCustomer(customer: BvnkCustomer): BvnkRuleEntity {
  const person = customer.individual?.person;
  if (person === undefined) {
    throw internalError(
      `BVNK customer ${customer.reference} has no individual details for the payment rule`
    );
  }
  return {
    type: "INDIVIDUAL",
    relationshipType: "SELF_OWNED",
    customerIdentifier: customer.reference,
    firstName: person.firstName,
    lastName: person.lastName,
    dateOfBirth: person.dateOfBirth,
    address: {
      addressLine1: person.address.addressLine1,
      city: person.address.city,
      country: person.address.countryCode,
      ...(person.address.addressLine2 === undefined
        ? {}
        : { addressLine2: person.address.addressLine2 }),
      ...(person.address.stateCode === undefined ? {} : { region: person.address.stateCode }),
      ...(person.address.postalCode === undefined ? {} : { postCode: person.address.postalCode }),
    },
  };
}

export const BVNK_NETWORKS = ["SOLANA"] as const;

export type BvnkNetwork = (typeof BVNK_NETWORKS)[number];

export const BVNK_CRYPTO_CURRENCIES = [
  "SOL",
  "USDC",
  "USDT",
] as const satisfies readonly CryptoAssetSymbol[];

export type BvnkCryptoCurrency = (typeof BVNK_CRYPTO_CURRENCIES)[number];

const BVNK_SOLANA_NETWORK_ALIASES = new Set(["sol", "solana"]);
const BVNK_CRYPTO_CURRENCY_SET = new Set<string>(BVNK_CRYPTO_CURRENCIES);

interface BvnkCurrencyNetwork {
  currency: BvnkCryptoCurrency;
  network: BvnkNetwork;
}

export function normalizeBvnkCurrencyAndNetwork(value: string): BvnkCurrencyNetwork {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw badRequest("cryptoToken must be a valid BVNK currency code");
  }

  const tokenParts = normalized.split("_").filter((part) => part.length > 0);
  const currency = tokenParts[0];
  if (!currency) {
    throw badRequest("cryptoToken must include a BVNK currency code");
  }

  const networkHint = tokenParts.length > 1 ? tokenParts[tokenParts.length - 1]?.toLowerCase() : "";
  if (networkHint && BVNK_SOLANA_NETWORK_ALIASES.has(networkHint)) {
    if (BVNK_CRYPTO_CURRENCY_SET.has(currency)) {
      return { currency: currency as BvnkCryptoCurrency, network: "SOLANA" };
    }
  }
  if (BVNK_CRYPTO_CURRENCY_SET.has(currency)) {
    return { currency: currency as BvnkCryptoCurrency, network: "SOLANA" };
  }

  throw badRequest(
    `Unsupported BVNK cryptoToken '${value}'. SDP BVNK ramps only support Solana assets (for example: SOL, USDC_SOLANA).`
  );
}

/**
 * Builds BVNK's `Idempotency-Key` header for fiat wallet creation.
 *
 * SDP's BVNK wallet `name` is the canonical wallet identity. BVNK caps
 * idempotency keys at 36 characters, so SDP hashes the full wallet name and
 * trims the digest to the provider limit instead of sending the long readable
 * name as the key.
 *
 * @param walletName BVNK wallet `name` generated by SDP.
 * @returns A stable 36-character idempotency key for the wallet name.
 */
export async function buildBvnkWalletIdempotencyKey(walletName: string): Promise<string> {
  return (await hashString(walletName)).slice(0, 36);
}

const BVNK_VERIFIED_STATUSES = new Set(["VERIFIED", "COMPLETED", "APPROVED"]);

/**
 * Whether a cached BVNK customer status counts as fully verified. The customer
 * KYC enum's success state is VERIFIED, but webhook events also report terminal
 * success as COMPLETED/APPROVED — treat all as verified.
 */
export function isBvnkCustomerVerified(status: string | undefined): boolean {
  return status !== undefined && BVNK_VERIFIED_STATUSES.has(status.toUpperCase());
}

/**
 * Maps a parsed v1 customer status to the client-facing verification
 * requirement. PENDING means the applicant is under review; INFO_REQUIRED and
 * ACTIONS_REQUIRED mean the applicant must still act and carry a JIT Sumsub
 * link; REJECTED and TERMINATED are terminal-negative; VERIFIED is ready.
 * Every status in the enum is mapped; the exhausted switch fails loudly on a
 * status the provider schema no longer knows.
 *
 * @param status - The v1 customer status parsed from the customer GET.
 * @param direction - Ramp direction used in the requirement response.
 * @param verificationUrl - The customer's current JIT verification URL, required
 *   when the status maps to `verification_required`.
 * @returns The verification requirement for the status, or `ready`.
 */
export function bvnkCustomerStatusRequirements(
  status: BvnkCustomerStatus,
  direction: RampDirection,
  verificationUrl?: string
): CounterpartyRequirements {
  switch (status) {
    case "VERIFIED":
      return readyCounterparty("bvnk", direction);
    case "PENDING":
      return { provider: "bvnk", direction, status: "customer_verifying" };
    case "INFO_REQUIRED":
    case "ACTIONS_REQUIRED": {
      if (!verificationUrl) {
        throw internalError(
          'BVNK reported "verification_required" without a JIT verification URL.'
        );
      }
      return {
        provider: "bvnk",
        direction,
        status: "customer_verification_required",
        verificationUrl,
      };
    }
    case "REJECTED":
    case "TERMINATED":
      return { provider: "bvnk", direction, status: "customer_verification_failed" };
    default: {
      const exhaustive: never = status;
      throw internalError(`Unhandled BVNK customer KYC status: ${String(exhaustive)}`);
    }
  }
}

/**
 * Builds the caller-defined BVNK off-ramp channel reference.
 *
 * The route pre-generates the SDP payment transfer id before creating the BVNK
 * channel, then persists the transfer with that same id after BVNK returns the
 * channel uuid. This keeps BVNK's human/provider-side reference tied to SDP's
 * transaction id.
 *
 * BVNK rejects `reference` values containing colons or other special
 * characters; allowed characters are alphanumeric characters, dashes,
 * underscores, and periods. This deliberately uses underscores instead of the
 * wallet-name convention (`sdp:offramp:...`) so the reference is accepted by
 * BVNK while still carrying SDP's transfer id.
 *
 * @param paymentTransferId SDP payment transfer id, for example `xfr_<uuid>`.
 * @returns BVNK off-ramp reference in `sdp_offramp_<transfer_id>` format.
 */
export function buildBvnkOfframpReference(paymentTransferId: string): string {
  if (!paymentTransferId.trim()) {
    throw internalError("BVNK off-ramp reference requires a payment transfer id.");
  }
  return `sdp_offramp_${paymentTransferId}`;
}

/**
 * Parses BVNK's channel transaction `data.reference` back into the SDP transfer id.
 *
 * @param reference BVNK off-ramp reference in `sdp_offramp_<transfer_id>` format.
 * @returns SDP payment transfer id (for example `xfr_<uuid>`), or undefined for a
 * channel payment SDP did not create — BVNK also delivers webhooks for foreign
 * transactions (sandbox tests, manual payments), which must be acked and ignored
 * rather than rejected.
 */
export function readBvnkOfframpReference(reference: string): string | undefined {
  const prefix = "sdp_offramp_";
  if (!reference.startsWith(prefix)) {
    return undefined;
  }
  const transferId = reference.slice(prefix.length);
  if (!/^xfr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transferId)) {
    return undefined;
  }
  return transferId;
}

/** Shared, one-per-counterparty BVNK customer (KYC) state. */
export interface BvnkCustomerResolution {
  /**
   * BVNK customer `externalReference` value. For SDP-created customers this is
   * the counterparty uuid without the `cpty_` prefix, which is exactly BVNK's
   * 36-character limit.
   */
  externalReference?: string;
  customerReference?: string;
  status?: string;
  verificationStatus?: string;
}

/**
 * Builds the value stored in BVNK's customer `externalReference` field.
 *
 * BVNK limits `externalReference` to 36 characters, while SDP counterparty ids
 * are `cpty_<uuid>` and therefore too long. The bare hyphenated uuid is exactly
 * 36 characters, so the prefix is dropped and nothing else changes. BVNK returns
 * this caller-provided value in customer/payment webhooks, letting handlers
 * reconstruct the SDP counterparty id and load by primary key.
 *
 * @param counterpartyId SDP counterparty primary key in `cpty_<uuid>` format.
 * @returns BVNK customer `externalReference`: the counterparty uuid without its prefix.
 * @throws SdpPaymentsError with `INTERNAL_ERROR` when the counterparty id cannot be
 * represented as a BVNK externalReference.
 */
export function buildBvnkCustomerExternalReference(counterpartyId: string): string {
  const match = SDP_COUNTERPARTY_ID_PATTERN.exec(counterpartyId);
  if (!match) {
    throw internalError(
      `Malformed SDP counterparty id for BVNK externalReference: ${counterpartyId}`
    );
  }
  return match.slice(1).join("-").toLowerCase();
}

const BVNK_CUSTOMER_EXTERNAL_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Recovers the SDP counterparty id from a BVNK customer `externalReference`.
 *
 * @param reference - Candidate external reference (a bare counterparty uuid).
 * @returns The `cpty_<uuid>` counterparty id, or null when the value is not an SDP external reference.
 */
export function parseBvnkCustomerExternalReference(reference: string): string | null {
  if (!BVNK_CUSTOMER_EXTERNAL_REFERENCE_PATTERN.test(reference)) {
    return null;
  }
  return `cpty_${reference}`;
}

const BVNK_WALLET_ACTIVE_STATUSES = new Set(["ACTIVE", "COMPLETED"]);

export function isBvnkWalletActive(status: string | undefined): boolean {
  return status !== undefined && BVNK_WALLET_ACTIVE_STATUSES.has(status.toUpperCase());
}

export function readBvnkData(
  providerData: CounterpartyRow["provider_data"]
): Record<string, unknown> {
  const bvnk = providerData.bvnk;
  return bvnk && typeof bvnk === "object" ? (bvnk as Record<string, unknown>) : {};
}

/** Merchant-owned BVNK off-ramp wallet, one per fiat currency. */
export interface BvnkOfframpWallet {
  id: string;
  status?: string;
}

export function buildBvnkOfframpWalletName(
  fiatCurrency: RampFiatCurrency,
  counterpartyId: string
): string {
  return `sdp:offramp:${fiatCurrency}:${counterpartyId}`;
}

/** Fiat currency SDP provisions BVNK customer funding wallets for (the US-only residence list this slice). */
export const BVNK_FUNDING_WALLET_FIAT = "USD" as const satisfies RampFiatCurrency;

/**
 * BVNK does not deduplicate concurrent wallet creates under one idempotency
 * key, so a freshly claimed funding-wallet row with no wallet reference is
 * treated as creation in flight. A claim older than this window is a crashed
 * claimer and is taken over; the name-hashed idempotency key makes that
 * takeover a non-concurrent retry, which BVNK does dedupe.
 */
export const BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS = 2 * 60 * 1000;

/** Builds the BVNK wallet name for a customer funding wallet, keyed by the customer-link row id. */
export function buildBvnkFundingWalletName(providerAccountId: string): string {
  return `sdp:onramp:${providerAccountId}`;
}

const BVNKMerchantOfframpWalletName = z.object({
  namespace: z.literal("sdp"),
  kind: z.literal("merchant_offramp"),
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
  counterpartyId: z.string().min(1),
});

const BVNKFundingWalletName = z.object({
  namespace: z.literal("sdp"),
  kind: z.literal("funding_wallet"),
  providerAccountId: z.string().min(1),
});

export const BVNKWallet = z.discriminatedUnion("kind", [
  BVNKMerchantOfframpWalletName,
  BVNKFundingWalletName,
]);

export type BVNKWallet = z.infer<typeof BVNKWallet>;

export function parseBvnkOfframpWalletName(
  walletName: string
): Extract<BVNKWallet, { kind: "merchant_offramp" }> {
  const parts = walletName.split(":");
  if (parts.length !== 4) {
    throw internalError(`Malformed BVNK off-ramp wallet name: ${walletName}`);
  }
  const [namespace, direction, fiatCurrency, counterpartyId] = parts;
  if (direction !== "offramp") {
    throw internalError(`Malformed BVNK off-ramp wallet name: ${walletName}`);
  }
  const parsed = BVNKMerchantOfframpWalletName.safeParse({
    namespace,
    kind: "merchant_offramp",
    fiatCurrency,
    counterpartyId,
  });
  if (!parsed.success) {
    throw internalError(`Malformed BVNK off-ramp wallet name: ${walletName}`);
  }
  return parsed.data;
}

/**
 * Parses a customer funding wallet name back into its SDP provider-account id.
 *
 * @param walletName BVNK wallet `name` value.
 * @returns Parsed provider-account id the funding wallet belongs to.
 * @throws SdpPaymentsError with `INTERNAL_ERROR` when the name does not match the
 * SDP funding wallet naming contract.
 */
export function parseBvnkFundingWalletName(
  walletName: string
): Extract<BVNKWallet, { kind: "funding_wallet" }> {
  const parts = walletName.split(":");
  if (parts.length !== 3) {
    throw internalError(`Malformed BVNK funding wallet name: ${walletName}`);
  }
  if (parts[1] !== "onramp") {
    throw internalError(`Malformed BVNK funding wallet name: ${walletName}`);
  }
  const parsed = BVNKFundingWalletName.safeParse({
    namespace: parts[0],
    kind: "funding_wallet",
    providerAccountId: parts[2],
  });
  if (!parsed.success) {
    throw internalError(`Malformed BVNK funding wallet name: ${walletName}`);
  }
  return parsed.data;
}

/**
 * Parses an SDP-created BVNK wallet name into its logical wallet reference, or
 * reports the name as unrecognised. The name's second segment is the
 * `direction` slot: `offramp` names the merchant off-ramp wallet and a 3-part
 * `onramp` name the customer funding wallet. Every other shape — including the
 * 6-part legacy rule-keyed on-ramp names sandbox still holds — is
 * `unrecognised`: webhooks must acknowledge those events terminal, never
 * retry them.
 *
 * @param walletName BVNK wallet `name` value.
 * @returns The parsed funding or merchant off-ramp wallet reference, or the
 * unrecognised name when it does not match either SDP naming contract.
 */
export function parseBvnkWalletName(walletName: string): BVNKWallet | BvnkUnrecognisedWalletName {
  const parts = walletName.split(":");
  if (parts[1] === "offramp" && parts.length === 4) {
    return parseBvnkOfframpWalletName(walletName);
  }
  if (parts[1] === "onramp" && parts.length === 3) {
    return parseBvnkFundingWalletName(walletName);
  }
  return { kind: "unrecognised", name: walletName };
}

/** A wallet name SDP no longer provisions or manages; its events are acknowledged, never retried. */
export interface BvnkUnrecognisedWalletName {
  kind: "unrecognised";
  name: string;
}

export function readBvnkOfframpWallets(
  providerData: CounterpartyRow["provider_data"]
): Record<string, BvnkOfframpWallet> {
  const offramp = readRecord(readBvnkData(providerData).offramp)?.wallets;
  return offramp && typeof offramp === "object"
    ? (offramp as Record<string, BvnkOfframpWallet>)
    : {};
}

export function withBvnkOfframpWalletStatus(
  providerData: CounterpartyRow["provider_data"],
  fiatCurrency: RampFiatCurrency,
  status: string
): CounterpartyRow["provider_data"] {
  const bvnk = readBvnkData(providerData);
  const offramp =
    bvnk.offramp && typeof bvnk.offramp === "object"
      ? (bvnk.offramp as Record<string, unknown>)
      : {};
  const wallets = readBvnkOfframpWallets(providerData);
  return {
    ...providerData,
    bvnk: {
      ...bvnk,
      offramp: {
        ...offramp,
        wallets: {
          ...wallets,
          [fiatCurrency]: { ...wallets[fiatCurrency], status },
        },
      },
    },
  };
}

export function readBvnkOfframpWallet(
  providerData: CounterpartyRow["provider_data"],
  fiatCurrency: string
): BvnkOfframpWallet | undefined {
  return readBvnkOfframpWallets(providerData)[fiatCurrency];
}

/** A registered off-ramp payout beneficiary. PII-light: raw account details are not stored. */
export interface BvnkOfframpBeneficiary {
  /** `${fiatCurrency}:${hash(collectedData)}` — content-addressed so distinct bank details never collide. */
  key: string;
  fiatCurrency: string;
  accountType: string;
  createdAt: string;
}

export function readBvnkOfframpBeneficiaries(
  providerData: CounterpartyRow["provider_data"]
): Record<string, unknown> {
  const beneficiaries = readRecord(readBvnkData(providerData).offramp)?.beneficiaries;
  return beneficiaries && typeof beneficiaries === "object"
    ? (beneficiaries as Record<string, unknown>)
    : {};
}

function parseBvnkOfframpBeneficiary(key: string, value: unknown): BvnkOfframpBeneficiary {
  const { fiatCurrency, accountType, createdAt } = value as {
    fiatCurrency?: unknown;
    accountType?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof fiatCurrency !== "string" ||
    typeof accountType !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw internalError(`Malformed BVNK off-ramp beneficiary "${key}" in provider_data`);
  }
  return { key, fiatCurrency, accountType, createdAt };
}

export function readBvnkOfframpBeneficiaryByKey(
  providerData: CounterpartyRow["provider_data"],
  key: string
): BvnkOfframpBeneficiary | null {
  const value = readBvnkOfframpBeneficiaries(providerData)[key];
  return value === undefined ? null : parseBvnkOfframpBeneficiary(key, value);
}

export function latestBvnkOfframpBeneficiary(
  providerData: CounterpartyRow["provider_data"],
  fiatCurrency: string
): BvnkOfframpBeneficiary | null {
  const entries = Object.entries(readBvnkOfframpBeneficiaries(providerData))
    .filter(([key]) => key.startsWith(`${fiatCurrency}:`))
    .map(([key, value]) => parseBvnkOfframpBeneficiary(key, value))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries[0] ?? null;
}

export function buildBvnkPartyDetails(counterparty: CounterpartyRow): never {
  throw badRequest(
    `BVNK offramp requires identity fields for counterparty ${counterparty.id} that are no longer stored; JIT collection is not wired yet`
  );
}
