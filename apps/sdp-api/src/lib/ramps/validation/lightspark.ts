import type { Counterparty } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { z } from "zod";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError, badRequest, unsupportedCounterparty } from "@/lib/errors";
import { latestLightsparkPayoutAccount } from "../providers/lightspark";
import { buildRequirementSchema, readyCounterparty, selectField, textField } from "../requirements";
import type { ValidateCounterpartyOptions } from "../types";

const SWIFT_BIC_PATTERN = "^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$";
const INTERNATIONAL_PHONE_PATTERN = "^\\+[0-9]{6,14}$";

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
  MOBILE_MONEY: "Mobile money",
} as const satisfies Record<string, string>;

export type LightsparkPaymentRail = keyof typeof LIGHTSPARK_RAIL_LABELS;

function railOption(value: LightsparkPaymentRail): RequirementOption {
  return { value, label: LIGHTSPARK_RAIL_LABELS[value] };
}

function bankNameField(): RequirementField {
  return textField({
    key: "bankName",
    label: "Bank name",
    required: true,
    maxLength: 256,
    placeholder: "Chase",
  });
}

function swiftCodeField(required: boolean): RequirementField {
  return textField({
    key: "swiftCode",
    label: "SWIFT / BIC code",
    required,
    pattern: SWIFT_BIC_PATTERN,
    placeholder: "DEUTDEFF",
  });
}

function accountNumberField(pattern?: string): RequirementField {
  return textField({
    key: "accountNumber",
    label: "Account number",
    required: true,
    maxLength: 64,
    placeholder: "12345678",
    ...(pattern ? { pattern } : {}),
  });
}

function ibanField(pattern?: string): RequirementField {
  return textField({
    key: "iban",
    label: "IBAN",
    required: true,
    minLength: 15,
    maxLength: 34,
    placeholder: "DE89370400440532013000",
    ...(pattern ? { pattern } : {}),
  });
}

function phoneNumberField(pattern: string): RequirementField {
  return textField({
    key: "phoneNumber",
    label: "Phone number",
    required: true,
    pattern,
    placeholder: "+254700000000",
  });
}

function mobileMoneyProviderField(): RequirementField {
  return textField({
    key: "provider",
    label: "Mobile money provider",
    required: true,
    maxLength: 128,
    placeholder: "M-Pesa",
  });
}

export interface LightsparkPayoutSpec {
  accountType: string;
  rails: readonly [LightsparkPaymentRail, ...LightsparkPaymentRail[]];
  fields: readonly RequirementField[];
}

export const LIGHTSPARK_PAYOUT_CURRENCIES = [
  "AED",
  "BRL",
  "BWP",
  "CAD",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "IDR",
  "INR",
  "KES",
  "MWK",
  "MXN",
  "MYR",
  "NGN",
  "PHP",
  "RWF",
  "SGD",
  "THB",
  "TZS",
  "UGX",
  "USD",
  "VND",
  "XAF",
  "XOF",
  "ZAR",
] as const satisfies readonly RampFiatCurrency[];

export type LightsparkPayoutCurrency = (typeof LIGHTSPARK_PAYOUT_CURRENCIES)[number];

const LIGHTSPARK_PAYOUT_SPECS = {
  AED: {
    accountType: "AED_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [ibanField("^AE[0-9]{21}$"), swiftCodeField(false)],
  },
  BRL: {
    accountType: "BRL_ACCOUNT",
    rails: ["PIX"],
    fields: [
      textField({ key: "pixKey", label: "PIX key", required: true, maxLength: 128 }),
      selectField({
        key: "pixKeyType",
        label: "PIX key type",
        required: true,
        options: [
          { value: "CPF", label: "CPF" },
          { value: "CNPJ", label: "CNPJ" },
          { value: "EMAIL", label: "Email" },
          { value: "PHONE", label: "Phone" },
          { value: "RANDOM", label: "Random (EVP)" },
        ],
      }),
      textField({ key: "taxId", label: "Tax ID", required: true, maxLength: 32 }),
    ],
  },
  BWP: {
    accountType: "BWP_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField(INTERNATIONAL_PHONE_PATTERN), mobileMoneyProviderField()],
  },
  CAD: {
    accountType: "CAD_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [
      textField({ key: "bankCode", label: "Bank code", required: true, pattern: "^[0-9]{3}$" }),
      textField({
        key: "branchCode",
        label: "Branch transit number",
        required: true,
        pattern: "^[0-9]{5}$",
      }),
      accountNumberField("^[0-9]{7,12}$"),
    ],
  },
  DKK: {
    accountType: "DKK_ACCOUNT",
    rails: ["SEPA", "SEPA_INSTANT"],
    fields: [ibanField(), swiftCodeField(false)],
  },
  EUR: {
    accountType: "EUR_ACCOUNT",
    rails: ["SEPA", "SEPA_INSTANT"],
    fields: [ibanField(), swiftCodeField(false)],
  },
  GBP: {
    accountType: "GBP_ACCOUNT",
    rails: ["FASTER_PAYMENTS"],
    fields: [
      textField({
        key: "sortCode",
        label: "Sort code",
        required: true,
        pattern: "^[0-9]{2}-?[0-9]{2}-?[0-9]{2}$",
        placeholder: "12-34-56",
        mask: "##-##-##",
      }),
      accountNumberField("^[0-9]{8}$"),
    ],
  },
  HKD: {
    accountType: "HKD_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), swiftCodeField(true), accountNumberField()],
  },
  IDR: {
    accountType: "IDR_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [
      bankNameField(),
      swiftCodeField(true),
      accountNumberField(),
      phoneNumberField("^\\+62[0-9]{9,12}$"),
    ],
  },
  INR: {
    accountType: "INR_ACCOUNT",
    rails: ["UPI"],
    fields: [
      textField({
        key: "vpa",
        label: "UPI ID (VPA)",
        required: true,
        maxLength: 256,
        placeholder: "user@okbank",
      }),
    ],
  },
  KES: {
    accountType: "KES_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField(INTERNATIONAL_PHONE_PATTERN), mobileMoneyProviderField()],
  },
  MWK: {
    accountType: "MWK_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField("^\\+265[0-9]{9}$"), mobileMoneyProviderField()],
  },
  MXN: {
    accountType: "MXN_ACCOUNT",
    rails: ["SPEI"],
    fields: [
      textField({
        key: "clabeNumber",
        label: "CLABE number",
        required: true,
        pattern: "^[0-9]{18}$",
      }),
    ],
  },
  MYR: {
    accountType: "MYR_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), swiftCodeField(true), accountNumberField()],
  },
  NGN: {
    accountType: "NGN_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [accountNumberField("^[0-9]{10}$"), bankNameField()],
  },
  PHP: {
    accountType: "PHP_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), accountNumberField()],
  },
  RWF: {
    accountType: "RWF_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField("^\\+250[0-9]{9}$"), mobileMoneyProviderField()],
  },
  SGD: {
    accountType: "SGD_ACCOUNT",
    rails: ["PAYNOW", "FAST", "BANK_TRANSFER"],
    fields: [bankNameField(), swiftCodeField(true), accountNumberField()],
  },
  THB: {
    accountType: "THB_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), swiftCodeField(true), accountNumberField()],
  },
  TZS: {
    accountType: "TZS_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField("^\\+255[0-9]{9}$"), mobileMoneyProviderField()],
  },
  UGX: {
    accountType: "UGX_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [phoneNumberField("^\\+256[0-9]{9}$"), mobileMoneyProviderField()],
  },
  USD: {
    accountType: "USD_ACCOUNT",
    rails: ["ACH", "WIRE", "RTP", "FEDNOW"],
    fields: [
      textField({
        key: "routingNumber",
        label: "Routing number",
        required: true,
        pattern: "^[0-9]{9}$",
        placeholder: "021000021",
      }),
      accountNumberField("^[0-9]{4,17}$"),
    ],
  },
  VND: {
    accountType: "VND_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), swiftCodeField(true), accountNumberField()],
  },
  XAF: {
    accountType: "XAF_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [
      phoneNumberField(INTERNATIONAL_PHONE_PATTERN),
      mobileMoneyProviderField(),
      selectField({
        key: "region",
        label: "Region",
        required: true,
        options: [
          { value: "CM", label: "Cameroon" },
          { value: "CG", label: "Congo" },
        ],
      }),
    ],
  },
  XOF: {
    accountType: "XOF_ACCOUNT",
    rails: ["MOBILE_MONEY"],
    fields: [
      phoneNumberField(INTERNATIONAL_PHONE_PATTERN),
      mobileMoneyProviderField(),
      selectField({
        key: "countries",
        label: "Country",
        required: true,
        options: [
          { value: "SN", label: "Senegal" },
          { value: "BJ", label: "Benin" },
          { value: "CI", label: "Ivory Coast" },
        ],
      }),
    ],
  },
  ZAR: {
    accountType: "ZAR_ACCOUNT",
    rails: ["BANK_TRANSFER"],
    fields: [bankNameField(), accountNumberField("^[0-9]{9,13}$")],
  },
} as const satisfies Record<LightsparkPayoutCurrency, LightsparkPayoutSpec>;

export function isLightsparkPayoutCurrency(value: string): value is LightsparkPayoutCurrency {
  return Object.hasOwn(LIGHTSPARK_PAYOUT_SPECS, value);
}

export function lightsparkPayoutSpec(fiatCurrency: string): LightsparkPayoutSpec {
  if (!isLightsparkPayoutCurrency(fiatCurrency)) {
    throw badRequest(`Lightspark off-ramp does not support payouts in ${fiatCurrency}.`);
  }
  return LIGHTSPARK_PAYOUT_SPECS[fiatCurrency];
}

export function lightsparkPayoutFields(spec: LightsparkPayoutSpec): RequirementField[] {
  const railField =
    spec.rails.length > 1
      ? [
          selectField({
            key: "paymentRails",
            label: "Payment rail",
            required: true,
            options: spec.rails.map(railOption),
          }),
        ]
      : [];
  return [...railField, ...spec.fields];
}

export function lightsparkCounterpartyRequirements(
  _counterparty: Counterparty,
  { direction, providerData, fiatCurrency }: ValidateCounterpartyOptions
): CounterpartyRequirements {
  if (direction === "onramp") {
    return readyCounterparty("lightspark", direction);
  }
  if (!fiatCurrency) {
    throw badRequest("fiatCurrency is required for Lightspark off-ramp requirements.");
  }
  if (!isLightsparkPayoutCurrency(fiatCurrency)) {
    return unsupportedCounterparty(
      "lightspark",
      direction,
      `Lightspark off-ramp does not support payouts in ${fiatCurrency}.`
    );
  }
  if (latestLightsparkPayoutAccount(providerData, fiatCurrency)) {
    return readyCounterparty("lightspark", direction);
  }
  return {
    provider: "lightspark",
    direction,
    status: "collect",
    fields: lightsparkPayoutFields(LIGHTSPARK_PAYOUT_SPECS[fiatCurrency]),
  };
}

function lightsparkBeneficiary(counterparty: CounterpartyRow): Record<string, unknown> {
  if (counterparty.entity_type === "business") {
    return { beneficiaryType: "BUSINESS", legalName: counterparty.display_name };
  }
  const identity = counterparty.identity;
  return {
    beneficiaryType: "INDIVIDUAL",
    fullName: counterparty.display_name,
    ...(identity.dateOfBirth ? { birthDate: identity.dateOfBirth } : {}),
    ...(identity.compliance?.nationality ? { nationality: identity.compliance.nationality } : {}),
  };
}

export function buildLightsparkAccountInfo(
  counterparty: CounterpartyRow,
  fiatCurrency: RampFiatCurrency,
  collectedData: CollectedFieldData | undefined
): Record<string, unknown> {
  const spec = lightsparkPayoutSpec(fiatCurrency);
  if (!collectedData) {
    throw badRequest("collectedData with payout bank details is required for Lightspark off-ramp.");
  }
  const result = buildRequirementSchema(lightsparkPayoutFields(spec)).safeParse(collectedData);
  if (!result.success) {
    throw new AppError(
      "BAD_REQUEST",
      "Missing or invalid payout bank details for Lightspark off-ramp.",
      { errors: z.treeifyError(result.error) }
    );
  }
  const supplied: Record<string, unknown> = result.data;

  const rail = spec.rails.length > 1 ? supplied.paymentRails : spec.rails[0];
  if (typeof rail !== "string") {
    throw badRequest('Missing required field "paymentRails" for Lightspark off-ramp.');
  }

  const accountInfo: Record<string, unknown> = {
    accountType: spec.accountType,
    paymentRails: [rail],
  };
  for (const field of spec.fields) {
    const value = supplied[field.key];
    if (value === undefined) continue;
    accountInfo[field.key] = field.key === "countries" ? [value] : value;
  }
  accountInfo.beneficiary = lightsparkBeneficiary(counterparty);
  return accountInfo;
}
