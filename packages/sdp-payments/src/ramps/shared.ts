import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  CRYPTO_RAIL_ASSET_LABELS,
  type CryptoAssetSymbol,
  type CryptoRailId,
  type RampCountrySupport,
  type RampCurrencyLimit,
} from "@sdp/types/payment-rails";
import { internalError, providerNotConfigured } from "#/errors";
import type { RampProvider, RampProviderCredentials, RampRuntimeContext } from "#/ramps/types";

let icuModernCurrencies: Set<string> | undefined;
let countryDisplayNames: Intl.DisplayNames | undefined;

function getIcuModernCurrencies(): Set<string> {
  if (icuModernCurrencies === undefined) {
    icuModernCurrencies = new Set(Intl.supportedValuesOf("currency"));
  }
  return icuModernCurrencies;
}

/**
 * Codes ICU still reports as modern currencies that no region tenders any more.
 * `Intl.supportedValuesOf("currency")` answers "does CLDR carry this code", not
 * "is this money" — it keeps a code for years past withdrawal — which is how
 * currencies nobody can transact reached the pickers.
 *
 * Dates are when the last issuing region stopped tendering, per CLDR
 * supplemental currencyData: cldr-json/cldr-core/supplemental/currencyData.json.
 * Recheck after an ICU bump — a code is dead there when every region entry for
 * it carries a `_to` date or is marked non-tender.
 */
const RETIRED_ISO_4217_CODES: ReadonlySet<string> = new Set([
  "ANG", // to 2025-06-30 - Netherlands Antillean guilder, succeeded by XCG
  "BGN", // to 2026-01-31 - Bulgarian lev, succeeded by EUR
  "CUC", // to 2021-06-01 - Cuban convertible peso, succeeded by CUP
  "HRK", // to 2023-01-14 - Croatian kuna, succeeded by EUR
  "SLL", // to 2023-12-31 - Sierra Leonean leone, redenominated as SLE
  "SVC", // to 2001-01-01 - Salvadoran colon, succeeded by USD
  "ZWL", // to 2024-08-31 - Zimbabwean dollar, succeeded by ZWG
  "XDR", // non-tender - IMF special drawing rights
  "XSU", // non-tender - ALBA sucre, unit of account only
]);

function getCountryDisplayNames(): Intl.DisplayNames {
  if (countryDisplayNames === undefined) {
    countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
  }
  return countryDisplayNames;
}

export type SolanaCryptoAsset = CryptoAssetSymbol;

export const SOLANA_ASSET_TO_RAIL = Object.fromEntries(
  Object.entries(CRYPTO_RAIL_ASSET_LABELS).map(([rail, asset]) => [asset, rail])
) as Record<SolanaCryptoAsset, CryptoRailId>;

export function isSolanaCryptoAsset(value: string): value is SolanaCryptoAsset {
  return value in SOLANA_ASSET_TO_RAIL;
}

export function unreportedCurrencyLimit(): RampCurrencyLimit {
  return { min: null, max: null };
}

export const UNREPORTED_COUNTRY_SUPPORT = {
  coverage: "unreported",
} as const satisfies RampCountrySupport;

/** True only for currencies a counterparty can still be paid in today. */
export function isActiveIso4217CurrencyCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return (
    /^[A-Z]{3}$/.test(normalized) &&
    !RETIRED_ISO_4217_CODES.has(normalized) &&
    getIcuModernCurrencies().has(normalized)
  );
}

export function isIso3166Alpha2CountryCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return false;
  }
  const displayName = getCountryDisplayNames().of(normalized);
  return displayName !== undefined && displayName !== normalized;
}

/** The format of each key in each mode: a provider's keys name the mode they run in. */
export type RampKeyFormats = Readonly<
  Record<SdpEnvironment, Readonly<Record<keyof RampProviderCredentials, RegExp>>>
>;

const KEY_MODE_NAMES = {
  sandbox: "test-mode",
  production: "live-mode",
} as const satisfies Record<SdpEnvironment, string>;

/**
 * Every provider's `checkCredentials`: why `credentials` can't serve `mode`
 * under `formats`, or null when both keys fit it.
 *
 * @param label - The provider's name in the refusal.
 * @param formats - The provider's key formats by mode.
 * @param credentials - The keys to check.
 * @param mode - The mode the call runs in.
 * @returns The refusal, or null.
 */
export function checkRampKeyFormats(
  label: string,
  formats: RampKeyFormats,
  credentials: RampProviderCredentials,
  mode: SdpEnvironment
): string | null {
  const format = formats[mode];
  if (
    format.publicKey.test(credentials.publicKey) &&
    format.secretKey.test(credentials.secretKey)
  ) {
    return null;
  }
  return `${label} ${mode} keys must be ${KEY_MODE_NAMES[mode]} keys.`;
}

/**
 * `ctx`'s keys, once `provider` confirms they fit `ctx.mode`. Every provider
 * call reads its keys here, so a key from the other mode never makes a request.
 *
 * @param provider - The provider making the call.
 * @param ctx - The call's runtime.
 * @returns The keys.
 * @throws SdpPaymentsError PROVIDER_NOT_CONFIGURED when they don't fit the mode.
 */
export function rampCredentials(
  provider: Pick<RampProvider, "checkCredentials">,
  ctx: RampRuntimeContext
): RampProviderCredentials {
  const refusal = provider.checkCredentials(ctx.credentials, ctx.mode);
  if (refusal !== null) {
    throw providerNotConfigured(refusal);
  }
  return ctx.credentials;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${globalThis.btoa(`${username}:${password}`)}`;
}

export const PAYMENT_TRANSFER_ID_PREFIX = "xfr_";

const PAYMENT_TRANSFER_ID_PATTERN =
  /^xfr_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Whether a string is an SDP payment transfer id (`xfr_<uuid>`). */
export function isPaymentTransferId(value: string): boolean {
  return PAYMENT_TRANSFER_ID_PATTERN.test(value);
}

/**
 * The UUID inside an SDP payment transfer id, for providers whose partner
 * reference field only accepts a bare UUID.
 *
 * @param transferId - An SDP payment transfer id (`xfr_<uuid>`).
 * @returns The UUID without the `xfr_` prefix.
 * @throws When the id is not an SDP payment transfer id.
 */
export function paymentTransferUuid(transferId: string): string {
  const match = PAYMENT_TRANSFER_ID_PATTERN.exec(transferId);
  if (!match) {
    throw internalError(`Not an SDP payment transfer id: ${transferId}`);
  }
  return match[1];
}

export function rampId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function dumpFile<TName extends string>(name: TName): `${TName}.json` {
  return `${name}.json`;
}

export const RAMP_RAIL_DUMPS = {
  moonpay: {
    currencies: { name: "moonpay/currencies", file: dumpFile("moonpay/currencies") },
    countries: { name: "moonpay/countries", file: dumpFile("moonpay/countries") },
  },
} as const;
