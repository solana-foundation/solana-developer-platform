import { COUNTRIES, type Counterparty, type CountryCode, isCountryCode } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { OFFRAMP_PAYOUT_ACCOUNTS, OFFRAMP_SWIFT_SUPPORT } from "@sdp/types/generated/ramp";
import type { RampPayoutAccountSpec, RampPayoutFieldSpec } from "@sdp/types/payment-rails";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "../../../counterparty";
import { badRequest, providerUnavailable, unsupportedCounterparty } from "../../../errors";
import {
  dateField,
  parseCollectedFields,
  readyCounterparty,
  selectField,
  textField,
} from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import { latestLightsparkPayoutAccount } from "./provider-data";

const LIGHTSPARK_RAIL_LABELS = {
  ACH: "ACH",
  WIRE: "Wire",
  RTP: "RTP",
  FEDNOW: "FedNow",
  SEPA: "SEPA",
  SEPA_INSTANT: "SEPA Instant",
  PAYNOW: "PayNow",
  FAST: "FAST",
  BANK_TRANSFER: "Bank transfer",
  FASTER_PAYMENTS: "Faster Payments",
  SPEI: "SPEI",
  PIX: "PIX",
  UPI: "UPI",
  NEFT: "NEFT",
  RTGS: "RTGS",
  MOBILE_MONEY: "Mobile money",
  SWIFT: "SWIFT",
} as const satisfies Record<string, string>;

export type LightsparkPaymentRail = keyof typeof LIGHTSPARK_RAIL_LABELS;

const LIGHTSPARK_PAYOUT_ACCOUNTS: Readonly<Record<string, RampPayoutAccountSpec>> =
  OFFRAMP_PAYOUT_ACCOUNTS.lightspark;
const LIGHTSPARK_SWIFT_ACCOUNT: RampPayoutAccountSpec = OFFRAMP_SWIFT_SUPPORT.lightspark.account;

/** UI copy for every field key the generated payout accounts can carry. */
const LIGHTSPARK_FIELD_COPY = {
  accountNumber: { label: "Account number", placeholder: "12345678" },
  bankAccountType: { label: "Account type" },
  bankCode: { label: "Bank code" },
  bankName: { label: "Bank name", placeholder: "Chase" },
  branchCode: { label: "Branch code" },
  clabeNumber: { label: "CLABE", placeholder: "002010077777777771" },
  country: { label: "Bank country (ISO code)", placeholder: "MY" },
  fiToFiInformation: { label: "Bank-to-bank instructions" },
  iban: { label: "IBAN", placeholder: "DE89370400440532013000" },
  ifsc: { label: "IFSC", placeholder: "HDFC0001234" },
  intermediaryBankName: { label: "Intermediary bank name" },
  intermediaryRoutingNumber: { label: "Intermediary routing number" },
  phoneNumber: { label: "Phone number", placeholder: "+254700000000" },
  pixKey: { label: "PIX key" },
  pixKeyType: { label: "PIX key type" },
  provider: { label: "Mobile money provider", placeholder: "M-Pesa" },
  rail: { label: "Bank rail (NEFT or RTGS)", placeholder: "NEFT" },
  region: { label: "Region" },
  routingNumber: { label: "Routing number", placeholder: "021000021" },
  sortCode: { label: "Sort code", placeholder: "12-34-56" },
  swiftCode: { label: "SWIFT / BIC code", placeholder: "DEUTDEFF" },
  taxId: { label: "Tax ID" },
  vpa: { label: "UPI ID (VPA)", placeholder: "user@okbank" },
} as const satisfies Record<string, { label: string; placeholder?: string }>;

/** Display labels for enumerated field values that are not country codes. */
const LIGHTSPARK_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bankAccountType: { CHECKING: "Checking", SAVINGS: "Savings" },
  pixKeyType: {
    CPF: "CPF",
    CNPJ: "CNPJ",
    EMAIL: "Email",
    PHONE: "Phone",
    RANDOM: "Random (EVP)",
  },
};

let regionDisplayNames: Intl.DisplayNames | undefined;

/**
 * Resolves the display label for one enumerated field value: the curated map
 * first, then region display names for ISO country codes.
 *
 * @param fieldKey - Field the value belongs to.
 * @param value - Enumerated value from the generated spec.
 * @returns Human-readable option label.
 */
function lightsparkValueLabel(fieldKey: string, value: string): string {
  const curated = LIGHTSPARK_VALUE_LABELS[fieldKey]?.[value];
  if (curated !== undefined) {
    return curated;
  }
  if (/^[A-Z]{2}$/.test(value)) {
    if (regionDisplayNames === undefined) {
      regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
    }
    const displayName = regionDisplayNames.of(value);
    if (displayName !== undefined && displayName !== value) {
      return displayName;
    }
  }
  throw providerUnavailable(`Lightspark field ${fieldKey} has no label for value ${value}.`);
}

/**
 * Maps one generated payout field spec onto a requirement field.
 *
 * @param key - Field key within the account schema.
 * @param spec - Generated validation spec for the field.
 * @param required - Requiredness in the rendering context (relaxed in the
 * cross-rail union, exact when validating one rail).
 * @returns Requirement field ready for collection or validation.
 */
function lightsparkRequirementField(
  key: string,
  spec: RampPayoutFieldSpec,
  required: boolean
): RequirementField {
  const copy: { label: string; placeholder?: string } | undefined =
    LIGHTSPARK_FIELD_COPY[key as keyof typeof LIGHTSPARK_FIELD_COPY];
  if (copy === undefined) {
    throw providerUnavailable(`Lightspark payout field ${key} has no UI copy.`);
  }
  if (spec.values !== undefined) {
    return selectField({
      key,
      label: copy.label,
      required,
      options: spec.values.map((value) => ({
        value,
        label: lightsparkValueLabel(key, value),
      })),
    });
  }
  return textField({
    key,
    label: copy.label,
    required,
    ...(spec.pattern !== undefined ? { pattern: spec.pattern } : {}),
    ...(spec.minLength !== undefined ? { minLength: spec.minLength } : {}),
    ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
    ...(spec.mask !== undefined ? { mask: spec.mask } : {}),
    ...(copy.placeholder !== undefined ? { placeholder: copy.placeholder } : {}),
  });
}

interface LightsparkPayoutRail {
  accountType: string;
  fields: Readonly<Record<string, RampPayoutFieldSpec>>;
}

/**
 * All rails a payout in the currency can go over: the currency account's own
 * rails plus SWIFT, which is available for every supported currency.
 *
 * @param fiatCurrency - Off-ramp payout currency.
 * @returns Rail table keyed by rail id, or undefined for unsupported currencies.
 */
export function lightsparkPayoutRails(
  fiatCurrency: string
): Readonly<Record<string, LightsparkPayoutRail>> | undefined {
  const account = LIGHTSPARK_PAYOUT_ACCOUNTS[fiatCurrency];
  if (account === undefined) {
    return undefined;
  }
  const rails: Record<string, LightsparkPayoutRail> = {};
  for (const [rail, fields] of Object.entries(account.rails)) {
    rails[rail] = { accountType: account.accountType, fields };
  }
  const swiftFields = LIGHTSPARK_SWIFT_ACCOUNT.rails.SWIFT;
  if (swiftFields === undefined) {
    throw providerUnavailable("Lightspark SWIFT account spec is missing its SWIFT rail.");
  }
  rails.SWIFT = { accountType: LIGHTSPARK_SWIFT_ACCOUNT.accountType, fields: swiftFields };
  return rails;
}

function requireLightsparkPayoutRails(
  fiatCurrency: string
): Readonly<Record<string, LightsparkPayoutRail>> {
  const rails = lightsparkPayoutRails(fiatCurrency);
  if (rails === undefined) {
    throw badRequest(`Lightspark off-ramp does not support payouts in ${fiatCurrency}.`);
  }
  return rails;
}

function lightsparkRailLabel(rail: string): string {
  const label: string | undefined =
    LIGHTSPARK_RAIL_LABELS[rail as keyof typeof LIGHTSPARK_RAIL_LABELS];
  if (label === undefined) {
    throw providerUnavailable(`Lightspark payment rail ${rail} has no label.`);
  }
  return label;
}

/**
 * Business details collected to create the Grid BUSINESS customer. Values pass
 * through to Grid just-in-time and are never persisted.
 *
 * @returns Business requirement fields for a business counterparty.
 */
export function lightsparkBusinessInfoFields(): RequirementField[] {
  return [
    textField({
      key: "businessLegalName",
      label: "Legal business name",
      required: true,
      maxLength: 256,
      placeholder: "Acme Corporation, Inc.",
    }),
    textField({
      key: "businessTaxId",
      label: "Business tax ID",
      required: true,
      maxLength: 32,
      placeholder: "47-1234567",
    }),
    dateField({
      key: "businessIncorporatedOn",
      label: "Date of incorporation",
      required: true,
      before: new Date().toISOString().slice(0, 10),
    }),
  ];
}

export interface LightsparkBusinessInfo {
  legalName: string;
  taxId: string;
  incorporatedOn: string;
}

/**
 * Maps collected business onboarding fields into the Grid createCustomer
 * businessInfo payload. Collected values pass through to Grid and are never
 * persisted.
 */
export function buildLightsparkBusinessInfo(
  collectedData: CollectedFieldData | undefined
): LightsparkBusinessInfo {
  if (!collectedData) {
    throw badRequest(
      "collectedData with business details is required to onboard a business counterparty with Lightspark."
    );
  }
  const supplied = parseCollectedFields(
    lightsparkBusinessInfoFields(),
    collectedData,
    "Missing or invalid business details for Lightspark onboarding."
  );
  const legalName = supplied.businessLegalName;
  const taxId = supplied.businessTaxId;
  const incorporatedOn = supplied.businessIncorporatedOn;
  if (
    typeof legalName !== "string" ||
    typeof taxId !== "string" ||
    typeof incorporatedOn !== "string"
  ) {
    throw badRequest("Missing required business details for Lightspark onboarding.");
  }
  return { legalName, taxId, incorporatedOn };
}

/**
 * Narrows collected data to the payout-spec fields so business onboarding
 * fields don't leak into the external-account payload or its content hash.
 * Returns undefined when no payout fields were collected.
 */
export function lightsparkPayoutCollectedData(
  fiatCurrency: string,
  collectedData: CollectedFieldData
): CollectedFieldData | undefined {
  const rails = requireLightsparkPayoutRails(fiatCurrency);
  const payoutKeys = new Set(["paymentRails"]);
  for (const rail of Object.values(rails)) {
    for (const key of Object.keys(rail.fields)) {
      payoutKeys.add(key);
    }
  }
  const payoutData = Object.fromEntries(
    Object.entries(collectedData).filter(([key]) => payoutKeys.has(key))
  );
  return Object.keys(payoutData).length > 0 ? payoutData : undefined;
}

/**
 * Collection fields for a payout in the currency: a rail selector plus the
 * union of every rail's fields. A field is only marked required when every
 * rail demands it; exact per-rail requiredness is enforced when the external
 * account is built from the chosen rail.
 *
 * @param fiatCurrency - Off-ramp payout currency.
 * @returns Requirement fields for the collect step.
 */
export function lightsparkPayoutFields(fiatCurrency: string): RequirementField[] {
  const rails = requireLightsparkPayoutRails(fiatCurrency);
  const railEntries = Object.entries(rails);
  const railField = selectField({
    key: "paymentRails",
    label: "Payment rail",
    required: true,
    options: railEntries.map(([rail]) => ({ value: rail, label: lightsparkRailLabel(rail) })),
  });
  const union = new Map<
    string,
    { spec: RampPayoutFieldSpec; presentIn: number; requiredIn: number }
  >();
  for (const [, rail] of railEntries) {
    for (const [key, spec] of Object.entries(rail.fields)) {
      const existing = union.get(key);
      if (existing === undefined) {
        union.set(key, { spec, presentIn: 1, requiredIn: spec.required ? 1 : 0 });
        continue;
      }
      existing.presentIn += 1;
      if (spec.required) {
        existing.requiredIn += 1;
      }
    }
  }
  return [
    railField,
    ...[...union.entries()].map(([key, entry]) =>
      lightsparkRequirementField(key, entry.spec, entry.requiredIn === railEntries.length)
    ),
  ];
}

function lightsparkCountrySelect(key: string, label: string): RequirementField {
  return selectField({
    key,
    label,
    required: true,
    options: COUNTRIES.map((country) => ({ value: country.code, label: country.name })),
  });
}

/**
 * PII collected to create the Grid INDIVIDUAL customer. Values pass through
 * to Grid just-in-time and are never persisted.
 *
 * @returns Identity requirement fields for an individual counterparty.
 */
export function lightsparkIndividualInfoFields(): RequirementField[] {
  return [
    textField({ key: "customer.fullName", label: "Full name", required: true, maxLength: 256 }),
    dateField({
      key: "customer.birthDate",
      label: "Date of birth",
      required: true,
      before: new Date().toISOString().slice(0, 10),
    }),
    lightsparkCountrySelect("customer.nationality", "Nationality"),
    lightsparkCountrySelect("customer.region", "Region"),
    textField({
      key: "customer.email",
      label: "Email",
      required: true,
      maxLength: 320,
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      placeholder: "name@example.com",
    }),
    {
      kind: "address",
      key: "customer.address",
      label: "Residential address",
      required: true,
      fields: [
        textField({ key: "customer.address.line1", label: "Address line 1", required: true }),
        textField({ key: "customer.address.city", label: "City", required: true }),
        textField({
          key: "customer.address.subdivisionCode",
          label: "State / region",
          required: false,
        }),
        textField({ key: "customer.address.postalCode", label: "Postal code", required: true }),
        lightsparkCountrySelect("customer.address.countryCode", "Country"),
      ],
    },
  ];
}

export interface LightsparkIndividualInfo {
  fullName: string;
  birthDate: string;
  nationality: CountryCode;
  region: CountryCode;
  email: string;
  address: {
    line1: string;
    city: string;
    state?: string;
    postalCode: string;
    country: CountryCode;
  };
}

/**
 * Maps collected individual PII into the Grid createCustomer payload.
 * Collected values pass through to Grid and are never persisted.
 *
 * @param collectedData - Collected identity fields keyed by requirement key.
 * @returns The Grid individual customer info.
 */
export function buildLightsparkIndividualInfo(
  collectedData: CollectedFieldData | undefined
): LightsparkIndividualInfo {
  if (!collectedData) {
    throw badRequest(
      "collectedData with individual details is required to onboard an individual counterparty with Lightspark."
    );
  }
  const supplied = parseCollectedFields(
    lightsparkIndividualInfoFields(),
    collectedData,
    "Missing or invalid individual details for Lightspark onboarding."
  );
  const fullName = supplied["customer.fullName"];
  const birthDate = supplied["customer.birthDate"];
  const nationality = supplied["customer.nationality"];
  const region = supplied["customer.region"];
  const email = supplied["customer.email"];
  const line1 = supplied["customer.address.line1"];
  const city = supplied["customer.address.city"];
  const subdivisionCode = supplied["customer.address.subdivisionCode"];
  const postalCode = supplied["customer.address.postalCode"];
  const countryCode = supplied["customer.address.countryCode"];
  if (
    typeof fullName !== "string" ||
    typeof birthDate !== "string" ||
    typeof nationality !== "string" ||
    !isCountryCode(nationality) ||
    typeof region !== "string" ||
    !isCountryCode(region) ||
    typeof email !== "string" ||
    typeof line1 !== "string" ||
    typeof city !== "string" ||
    typeof postalCode !== "string" ||
    typeof countryCode !== "string" ||
    !isCountryCode(countryCode)
  ) {
    throw badRequest("Missing required individual details for Lightspark onboarding.");
  }
  return {
    fullName,
    birthDate,
    nationality,
    region,
    email,
    address: {
      line1,
      city,
      ...(typeof subdivisionCode === "string" && subdivisionCode.length > 0
        ? { state: subdivisionCode }
        : {}),
      postalCode,
      country: countryCode,
    },
  };
}

/**
 * Requirement state machine keyed on the handler-resolved
 * `counterparty_provider_accounts` link: no link → collect_counterparty (PII
 * to create the Grid customer); linked onramp → ready; linked offramp →
 * collect_account until a payout account exists for the currency.
 */
export function lightsparkCounterpartyRequirements(
  counterparty: Counterparty,
  options: ValidateCounterpartyOptions
): CounterpartyRequirements {
  if (options.providerCustomerReference === undefined) {
    return {
      provider: "lightspark",
      direction: options.direction,
      status: "collect_counterparty",
      fields:
        counterparty.entityType === "individual"
          ? lightsparkIndividualInfoFields()
          : lightsparkBusinessInfoFields(),
    };
  }
  if (options.direction === "onramp") {
    return readyCounterparty("lightspark", "onramp");
  }
  const { providerData, fiatCurrency } = options;
  if (!fiatCurrency) {
    throw badRequest("fiatCurrency is required for Lightspark off-ramp requirements.");
  }
  if (lightsparkPayoutRails(fiatCurrency) === undefined) {
    return unsupportedCounterparty(
      "lightspark",
      "offramp",
      `Lightspark off-ramp does not support payouts in ${fiatCurrency}.`
    );
  }
  if (latestLightsparkPayoutAccount(providerData, fiatCurrency)) {
    return readyCounterparty("lightspark", "offramp");
  }
  return {
    provider: "lightspark",
    direction: "offramp",
    status: "collect_account",
    fields: lightsparkPayoutFields(fiatCurrency),
  };
}

function lightsparkBeneficiary(counterparty: CounterpartyRow): Record<string, unknown> {
  if (counterparty.entity_type !== "individual") {
    return { beneficiaryType: "BUSINESS", legalName: counterparty.display_name };
  }
  return {
    beneficiaryType: "INDIVIDUAL",
    fullName: counterparty.display_name,
  };
}

export function buildLightsparkAccountInfo(
  counterparty: CounterpartyRow,
  fiatCurrency: RampFiatCurrency,
  collectedData: CollectedFieldData | undefined
): Record<string, unknown> {
  const rails = requireLightsparkPayoutRails(fiatCurrency);
  if (!collectedData) {
    throw badRequest("collectedData with payout bank details is required for Lightspark off-ramp.");
  }
  const railKey = collectedData.paymentRails;
  if (typeof railKey !== "string") {
    throw badRequest('Missing required field "paymentRails" for Lightspark off-ramp.');
  }
  const rail = rails[railKey];
  if (rail === undefined) {
    throw badRequest(`Lightspark cannot pay out ${fiatCurrency} over rail ${railKey}.`);
  }

  const railFields = Object.entries(rail.fields).map(([key, spec]) =>
    lightsparkRequirementField(key, spec, spec.required)
  );
  const supplied = parseCollectedFields(
    railFields,
    collectedData,
    "Missing or invalid payout bank details for Lightspark off-ramp."
  );

  const accountInfo: Record<string, unknown> = {
    accountType: rail.accountType,
    paymentRails: [railKey],
  };
  for (const key of Object.keys(rail.fields)) {
    const value = supplied[key];
    if (value === undefined) continue;
    accountInfo[key] = value;
  }
  accountInfo.beneficiary = lightsparkBeneficiary(counterparty);
  return accountInfo;
}
