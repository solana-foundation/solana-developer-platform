import { COUNTRY_CODES, type CountryCode } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { RequirementField } from "@sdp/types/ramp-requirements";
import {
  countryField,
  currencyField,
  dateField,
  enumOptions,
  selectField,
  textField,
} from "../../requirements";

export const BVNK_EMPLOYMENT_STATUSES = [
  "SELF_EMPLOYED",
  "SALARIED",
  "UNEMPLOYED",
  "RETIRED",
] as const;

export const BVNK_SOURCE_OF_FUNDS = [
  "SALARY",
  "PENSION",
  "SAVINGS",
  "SELF_EMPLOYMENT",
  "CRYPTO_TRADING",
  "GAMBLING",
  "REAL_ESTATE",
] as const;

export const BVNK_PEP_STATUSES = [
  "NOT_PEP",
  "FORMER_PEP_2_YEARS",
  "FORMER_PEP_OLDER",
  "DOMESTIC_PEP",
  "FOREIGN_PEP",
  "CLOSE_ASSOCIATES",
  "FAMILY_MEMBERS",
] as const;

export const BVNK_INTENDED_USES = [
  "TRANSFERS_OWN_WALLET",
  "TRANSFERS_FAMILY_FRIENDS",
  "INVESTMENTS",
  "GOODS_SERVICES",
  "DONATIONS",
] as const;

export const BVNK_YEARLY_INCOMES = [
  "INCOME_0_TO_50K",
  "INCOME_50K_TO_100K",
  "INCOME_100K_TO_250K",
  "INCOME_250K_TO_500K",
  "INCOME_500K_TO_750K",
  "INCOME_750K_TO_1M",
  "INCOME_ABOVE_1M",
] as const;

export const BVNK_INDUSTRY_SECTORS = [
  "INVESTMENT",
  "HEDGE_FUND",
  "MONEY_SERVICE_BUSINESS",
  "STO_ISSUER",
  "PRECIOUS_METALS",
  "NON_PROFIT",
  "REGISTERED_INVESTMENT_ADVISOR",
  "AGRICULTURE_FORESTRY_FISHING_HUNTING",
  "MINING",
  "UTILITIES",
  "CONSTRUCTION",
  "MANUFACTURING",
  "WHOLESALE_TRADE",
  "RETAIL_TRADE",
  "TRANSPORTATION_WAREHOUSING",
  "INFORMATION",
  "FINANCE_INSURANCE",
  "REAL_ESTATE_RENTAL_LEASING",
  "PROFESSIONAL_SCIENTIFIC_TECHNICAL_SERVICES",
  "MANAGEMENT_OF_COMPANIES_ENTERPRISES",
  "ADMINISTRATIVE_SUPPORT_WASTE_MANAGEMENT_REMEDIATION_SERVICES",
  "EDUCATIONAL_SERVICES",
  "HEALTH_CARE_SOCIAL_ASSISTANCE",
  "ARTS_ENTERTAINMENT_RECREATION",
  "ACCOMMODATION_FOOD_SERVICES",
  "OTHER_SERVICES",
  "PUBLIC_ADMINISTRATION",
  "NOT_CLASSIFIED",
  "ADULT_ENTERTAINMENT",
  "AUCTIONS",
  "AUTOMOBILES",
  "BLOCKCHAIN",
  "CRYPTO",
  "DRUGS",
  "EXPORT_IMPORT",
  "E_COMMERCE",
  "FINANCIAL_INSTITUTION",
  "GAMBLING",
  "INSURANCE",
  "MARKET_MAKER",
  "SHELL_BANK",
  "TRAVEL_TRANSPORT",
  "WEAPONS",
] as const;

/** Currencies BVNK accepts for the CDD expected-monthly-volume declaration. */
export const BVNK_EXPECTED_VOLUME_CURRENCIES = [
  "USD",
  "EUR",
] as const satisfies readonly RampFiatCurrency[];

const BVNK_NAME_MAX_LENGTH = 100;
const BVNK_EMAIL_MAX_LENGTH = 320;
const BVNK_EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
const BVNK_MONEY_AMOUNT_PATTERN = "^\\d+(\\.\\d{1,2})?$";
const BVNK_TAX_ID_MAX_LENGTH = 64;
/** Residences whose tax id has a fixed national format worth masking in the form. */
const BVNK_TAX_ID_FORMATS: Partial<
  Record<CountryCode, { label: string; mask: string; placeholder: string }>
> = {
  US: {
    label: "Tax identification number (SSN / ITIN)",
    mask: "###-##-####",
    placeholder: "123-45-6789",
  },
  DE: {
    label: "Tax identification number (Steuer-ID)",
    mask: "## ### ### ###",
    placeholder: "12 345 678 901",
  },
};
const BVNK_ACH_ACCOUNT_NUMBER_PATTERN = "^[0-9]{4,17}$";
const BVNK_ACH_ROUTING_NUMBER_PATTERN = "^[0-9]{9}$";
const BVNK_IBAN_PATTERN = "^[A-Z]{2}[0-9A-Z]{13,32}$";

/**
 * Jurisdictions covered by BVNK's US money transmitter licences (System Pay
 * Services (US), Inc., NMLS ID 2531294). The US address state select may only
 * offer these.
 */
export const BVNK_US_MTL_STATES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  ME: "Maine",
  MD: "Maryland",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  NE: "Nebraska",
  NH: "New Hampshire",
  NM: "New Mexico",
  NV: "Nevada",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  UT: "Utah",
  VT: "Vermont",
  WV: "West Virginia",
  WY: "Wyoming",
} as const satisfies Record<string, string>;

const BVNK_US_MTL_STATE_OPTIONS = Object.entries(BVNK_US_MTL_STATES).map(([value, label]) => ({
  value,
  label,
}));

/**
 * AUP Financial Crime Appendix I: countries BVNK refuses to onboard and SDP
 * must not offer as a tax residence or address country.
 */
const BVNK_PROHIBITED_COUNTRIES = [
  "AF",
  "BY",
  "CD",
  "CU",
  "KP",
  "HT",
  "IR",
  "IQ",
  "LB",
  "LY",
  "MM",
  "RU",
  "SO",
  "SS",
  "SD",
  "SY",
  "VE",
  "YE",
  "PS",
] as const satisfies readonly CountryCode[];

const BVNK_PROHIBITED_COUNTRY_SET = new Set<CountryCode>(BVNK_PROHIBITED_COUNTRIES);
const BVNK_ONBOARDABLE_COUNTRIES: CountryCode[] = COUNTRY_CODES.filter(
  (code) => !BVNK_PROHIBITED_COUNTRY_SET.has(code)
);

const BVNK_ONRAMP_BASE_FIELDS: RequirementField[] = [
  textField({
    key: "firstName",
    label: "First name",
    required: true,
    maxLength: BVNK_NAME_MAX_LENGTH,
  }),
  textField({
    key: "lastName",
    label: "Last name",
    required: true,
    maxLength: BVNK_NAME_MAX_LENGTH,
  }),
  dateField({
    key: "dateOfBirth",
    label: "Date of birth",
    required: true,
    before: new Date().toISOString().slice(0, 10),
  }),
  textField({
    key: "email",
    label: "Email",
    required: true,
    maxLength: BVNK_EMAIL_MAX_LENGTH,
    pattern: BVNK_EMAIL_PATTERN,
    placeholder: "name@example.com",
  }),
  countryField({
    key: "birthCountryCode",
    label: "Country of birth",
    required: true,
  }),
  countryField({
    key: "nationality",
    label: "Nationality",
    required: true,
  }),
  selectField({
    key: "cdd.employmentStatus",
    label: "Employment status",
    required: true,
    options: enumOptions(BVNK_EMPLOYMENT_STATUSES),
  }),
  selectField({
    key: "cdd.sourceOfFunds",
    label: "Source of funds",
    required: true,
    options: enumOptions(BVNK_SOURCE_OF_FUNDS),
  }),
  selectField({
    key: "cdd.pepStatus",
    label: "Politically exposed person status",
    required: true,
    options: enumOptions(BVNK_PEP_STATUSES),
  }),
  selectField({
    key: "cdd.intendedUseOfAccount",
    label: "Intended use of account",
    required: true,
    options: enumOptions(BVNK_INTENDED_USES),
  }),
  textField({
    key: "cdd.expectedMonthlyVolume.amount",
    label: "Expected monthly volume",
    required: true,
    pattern: BVNK_MONEY_AMOUNT_PATTERN,
    placeholder: "1000",
  }),
  currencyField({
    key: "cdd.expectedMonthlyVolume.currency",
    label: "Expected monthly volume currency",
    required: true,
    options: [...BVNK_EXPECTED_VOLUME_CURRENCIES],
  }),
];

/**
 * BVNK requires a tax identification number for every residence; residences
 * with a fixed national format get its label, mask, and placeholder.
 *
 * @param countryCode - The counterparty's residence country.
 * @returns The tax identification number field for that residence.
 */
function bvnkTaxIdField(countryCode: CountryCode): RequirementField {
  const format = BVNK_TAX_ID_FORMATS[countryCode];
  return textField({
    key: "taxIdentification.number",
    label: format === undefined ? "Tax identification number" : format.label,
    required: true,
    maxLength: BVNK_TAX_ID_MAX_LENGTH,
    ...(format === undefined ? {} : { placeholder: format.placeholder, mask: format.mask }),
  });
}

const BVNK_ONRAMP_US_FIELDS: RequirementField[] = [
  selectField({
    key: "cdd.estimatedYearlyIncome",
    label: "Estimated yearly income",
    required: true,
    options: enumOptions(BVNK_YEARLY_INCOMES),
  }),
  selectField({
    key: "cdd.employmentIndustrySector",
    label: "Employment industry sector",
    required: true,
    options: enumOptions(BVNK_INDUSTRY_SECTORS),
  }),
];

/**
 * Residence countries BVNK publishes an individual onboarding agreement for:
 * the US and the EEA. BVNK exposes no positive list, so this stays the set
 * SDP has verified agreements exist for rather than every non-prohibited country.
 */
const BVNK_RESIDENCE_COUNTRIES = [
  "US",
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IS",
  "IE",
  "IT",
  "LV",
  "LI",
  "LT",
  "LU",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
] as const satisfies readonly CountryCode[];

/**
 * First BVNK step: collects only the tax-residence country so agreements can
 * be minted for it before any other PII is requested.
 */
export const BVNK_RESIDENCE_FIELDS: RequirementField[] = [
  countryField({
    key: "taxIdentification.taxResidenceCountryCode",
    label: "Tax residence country",
    required: true,
    options: [...BVNK_RESIDENCE_COUNTRIES],
  }),
];

/**
 * The residence-specific address group. The US state select only renders once
 * the residence country is known, so the group is never part of the base pack.
 *
 * @param countryCode - The counterparty's residence country.
 * @returns The address requirement group for that residence country.
 */
function bvnkAddressGroup(countryCode: CountryCode): RequirementField {
  return {
    kind: "address",
    key: "address",
    label: "Residential address",
    required: true,
    fields: [
      textField({ key: "address.addressLine1", label: "Address line 1", required: true }),
      textField({ key: "address.city", label: "City", required: true }),
      ...(countryCode === "US"
        ? [
            selectField({
              key: "address.stateCode",
              label: "State",
              required: true,
              options: BVNK_US_MTL_STATE_OPTIONS,
            }),
          ]
        : []),
      textField({ key: "address.postalCode", label: "Postal code", required: true }),
      countryField({
        key: "address.countryCode",
        label: "Country",
        required: true,
        options: BVNK_ONBOARDABLE_COUNTRIES,
      }),
    ],
  };
}

/**
 * @param countryCode - The counterparty's residence country, known before the
 * full pack is collected.
 * @returns The BVNK collect fields for that residence country.
 */
export function bvnkOnrampFields(countryCode: CountryCode): RequirementField[] {
  return [
    ...BVNK_ONRAMP_BASE_FIELDS,
    bvnkAddressGroup(countryCode),
    bvnkTaxIdField(countryCode),
    ...(countryCode === "US" ? BVNK_ONRAMP_US_FIELDS : []),
  ];
}

interface BvnkOfframpSpec {
  accountType: string;
  fields: readonly RequirementField[];
}

/** Verified BVNK payout corridors: each fiat maps to its bank-detail field set. */
const BVNK_OFFRAMP_SPECS = {
  USD: {
    accountType: "ACH",
    fields: [
      textField({
        key: "accountNumber",
        label: "Account number",
        required: true,
        pattern: BVNK_ACH_ACCOUNT_NUMBER_PATTERN,
      }),
      textField({
        key: "routingNumber",
        label: "Routing number",
        required: true,
        pattern: BVNK_ACH_ROUTING_NUMBER_PATTERN,
        placeholder: "021000021",
      }),
    ],
  },
  EUR: {
    accountType: "SEPA_CT",
    fields: [
      textField({
        key: "iban",
        label: "IBAN",
        required: true,
        pattern: BVNK_IBAN_PATTERN,
        placeholder: "DE89370400440532013000",
      }),
    ],
  },
} as const satisfies Record<string, BvnkOfframpSpec>;

type BvnkOfframpCurrency = keyof typeof BVNK_OFFRAMP_SPECS;

export function isBvnkOfframpCurrency(value: string): value is BvnkOfframpCurrency {
  return Object.hasOwn(BVNK_OFFRAMP_SPECS, value);
}

export function bvnkOfframpAccountType(fiatCurrency: BvnkOfframpCurrency): string {
  return BVNK_OFFRAMP_SPECS[fiatCurrency].accountType;
}

export function bvnkOfframpFields(fiatCurrency: BvnkOfframpCurrency): RequirementField[] {
  return [...BVNK_OFFRAMP_SPECS[fiatCurrency].fields];
}
