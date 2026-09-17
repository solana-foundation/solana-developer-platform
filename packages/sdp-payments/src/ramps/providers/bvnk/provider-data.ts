import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoAssetSymbol } from "@sdp/types/payment-rails";
import type { CounterpartyRow } from "../../../counterparty";
import { badRequest, internalError } from "../../../errors";
import { hashString } from "../../../hash";
import { readRecord } from "../../../json";

export interface BvnkRuleEntityAddress {
  addressLine1: string;
  addressLine2?: string;
  postalCode?: string;
  city: string;
  countryCode: string;
  /** ISO 3166-1 alpha-2 country; BVNK rule validation rejects a blank `country`. */
  country: string;
  /** ISO 3166-2 region/state code; BVNK requires it for US beneficiaries. */
  stateCode?: string;
}

export type BvnkEntityType = "INDIVIDUAL" | "COMPANY";

/**
 * Beneficiary entity accepted by a BVNK on-ramp payment rule.
 */
export interface BvnkRuleEntity {
  type: BvnkEntityType;
  customerIdentifier: string;
  relationshipType: "SELF_OWNED" | "THIRD_PARTY";
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  legalName?: string;
  registrationNumber?: string;
  address?: BvnkRuleEntityAddress;
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
 * BVNK caps idempotency keys at 36 characters, so SDP hashes the provider
 * account row id (for example `counterparty_provider_account_<uuid>`) and
 * trims the digest to the provider limit.
 *
 * @param providerAccountRowId SDP `counterparty_provider_account_` row id the wallet maps to.
 * @returns A stable 36-character idempotency key for the provider account row.
 */
export async function buildBvnkWalletIdempotencyKey(providerAccountRowId: string): Promise<string> {
  return (await hashString(providerAccountRowId)).slice(0, 36);
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

/**
 * Builds the caller-defined BVNK on-ramp payment rule reference for one transfer.
 *
 * The Direct model creates one payment rule per on-ramp transfer (rule-as-lock),
 * so the reference carries the SDP payment transfer id. BVNK rejects colons and
 * other special characters in `reference` values, so this uses the same
 * underscore convention as `buildBvnkOfframpReference`.
 *
 * @param paymentTransferId SDP payment transfer id, for example `xfr_<uuid>`.
 * @returns BVNK on-ramp rule reference in `sdp_onramp_<transfer_id>` format.
 */
export function buildBvnkOnrampRuleReference(paymentTransferId: string): string {
  if (!paymentTransferId.trim()) {
    throw internalError("BVNK on-ramp rule reference requires a payment transfer id.");
  }
  return `sdp_onramp_${paymentTransferId}`;
}

/**
 * Parses BVNK crypto status-change `data.reference` back into the SDP transfer id.
 *
 * The reference is the on-ramp rule reference SDP itself mints via
 * `buildBvnkOnrampRuleReference`, so a reference without the `sdp_onramp_`
 * prefix belongs to a foreign payment (ack and ignore, never reject). The
 * remainder is compared for exact equality with the resolved in-flight
 * transfer, so no id-format validation is needed.
 *
 * @param reference BVNK crypto status-change reference in `sdp_onramp_<transfer_id>` format.
 * @returns SDP payment transfer id (for example `xfr_<uuid>`), or undefined when the
 * reference was not minted by SDP.
 */
export function readBvnkOnrampRuleReference(reference: string): string | undefined {
  const prefix = "sdp_onramp_";
  if (!reference.startsWith(prefix)) {
    return undefined;
  }
  return reference.slice(prefix.length);
}

const BVNK_WALLET_ACTIVE_STATUSES = new Set(["ACTIVE", "COMPLETED"]);

export function isBvnkWalletActive(status: string | null): boolean {
  return status !== null && BVNK_WALLET_ACTIVE_STATUSES.has(status.toUpperCase());
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
  status: string;
}

/**
 * Builds the display-only BVNK wallet name for the merchant-owned off-ramp
 * wallet, one per (counterparty, fiat). Webhook-to-row mapping keys on the
 * BVNK wallet id stored in `external_account_reference`, so the name is never
 * parsed back.
 *
 * @param counterpartyId SDP counterparty primary key.
 * @param fiatCurrency Fiat currency of the off-ramp wallet.
 * @returns BVNK wallet name in `sdp:offramp:<counterparty_id>:<fiat>` format.
 */
export function buildBvnkOfframpWalletName(
  counterpartyId: string,
  fiatCurrency: RampFiatCurrency
): string {
  return `sdp:offramp:${counterpartyId}:${fiatCurrency}`;
}

/**
 * Builds the display-only BVNK wallet name for the merchant-owned on-ramp
 * funding wallet, one per (counterparty, fiat). Webhook-to-row mapping keys on
 * the BVNK wallet id stored in `external_account_reference`, so the name is
 * never parsed back.
 *
 * @param counterpartyId SDP counterparty primary key.
 * @param fiatCurrency Fiat currency of the funding wallet.
 * @returns BVNK wallet name in `sdp:onramp:<counterparty_id>:<fiat>` format.
 */
export function buildBvnkOnrampWalletName(
  counterpartyId: string,
  fiatCurrency: RampFiatCurrency
): string {
  return `sdp:onramp:${counterpartyId}:${fiatCurrency}`;
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
