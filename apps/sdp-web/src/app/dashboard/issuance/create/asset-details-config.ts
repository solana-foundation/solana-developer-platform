import type { AssetCategory } from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import {
  type AccessControlMode,
  type CapacityKey,
  createInitialCapacities,
  type DraftState,
} from "./issuance-draft-wizard.types";

// Presentation config for the Step-2 "Asset details" form. Sections are chosen
// by (category, type) — not category alone — so a fiat-backed and a crypto-backed
// stablecoin collect genuinely different fields (fiat reserves vs. on-chain
// collateral + oracle), and equity / debt / fund each get their own instrument
// terms.

export type FieldControl = "text" | "textarea" | "number" | "select" | "toggle" | "currency";
type Translate = (key: MessageKey, values?: TranslationValues) => string;

// DraftState keys editable through a category detail section.
export type DetailFieldKey =
  | "backingType"
  | "pegCurrency"
  | "pegTarget"
  | "reserveAsset"
  | "reserveCustodian"
  | "redemptionEnabled"
  | "collateralizationRatio"
  | "oracleProvider"
  | "minCollateralRatio"
  | "issuerName"
  | "jurisdiction"
  | "offeringType"
  | "shareClass"
  | "votingRights"
  | "couponRate"
  | "maturityDate"
  | "seniority"
  | "fundStrategy"
  | "managementFee"
  | "netAssetValue"
  | "underlyingAsset"
  | "custodian"
  | "propertyType"
  | "propertyLocation";

export interface FieldDescriptor {
  key: DetailFieldKey;
  labelKey: MessageKey;
  control: FieldControl;
  placeholderKey?: MessageKey;
  helpKey?: MessageKey;
  options?: readonly { value: string; labelKey: MessageKey }[];
}

export interface DetailSection {
  titleKey: MessageKey;
  descriptionKey?: MessageKey;
  fields: readonly FieldDescriptor[];
}

const JURISDICTION_OPTIONS = [
  { value: "us", labelKey: "DashboardIssuance.config.unitedStates" },
  { value: "eu", labelKey: "DashboardIssuance.config.europeanUnion" },
  { value: "uk", labelKey: "DashboardIssuance.config.unitedKingdom" },
  { value: "sg", labelKey: "DashboardIssuance.config.singapore" },
  { value: "other", labelKey: "DashboardIssuance.config.other" },
] as const;

const OFFERING_OPTIONS = [
  { value: "reg_d", labelKey: "DashboardIssuance.config.regD" },
  { value: "reg_s", labelKey: "DashboardIssuance.config.regS" },
  { value: "reg_a", labelKey: "DashboardIssuance.config.regA" },
  { value: "public", labelKey: "DashboardIssuance.config.publicOffering" },
  { value: "other", labelKey: "DashboardIssuance.config.other" },
] as const;

const BACKING_OPTIONS = [
  { value: "fiat", labelKey: "DashboardIssuance.taxonomy.fiatBacked" },
  { value: "crypto", labelKey: "DashboardIssuance.taxonomy.cryptoBacked" },
  { value: "commodity", labelKey: "DashboardIssuance.config.commodityBacked" },
  { value: "algorithmic", labelKey: "DashboardIssuance.config.algorithmic" },
] as const;

const SENIORITY_OPTIONS = [
  { value: "senior_secured", labelKey: "DashboardIssuance.config.seniorSecured" },
  { value: "senior_unsecured", labelKey: "DashboardIssuance.config.seniorUnsecured" },
  { value: "subordinated", labelKey: "DashboardIssuance.config.subordinated" },
  { value: "mezzanine", labelKey: "DashboardIssuance.config.mezzanine" },
  { value: "unsecured", labelKey: "DashboardIssuance.config.unsecured" },
] as const;

const FUND_STRATEGY_OPTIONS = [
  { value: "money_market", labelKey: "DashboardIssuance.config.strategyMoneyMarket" },
  { value: "fixed_income", labelKey: "DashboardIssuance.config.strategyFixedIncome" },
  { value: "equity", labelKey: "DashboardIssuance.config.strategyEquity" },
  { value: "multi_asset", labelKey: "DashboardIssuance.config.strategyMultiAsset" },
  { value: "other", labelKey: "DashboardIssuance.config.other" },
] as const;

const PROPERTY_TYPE_OPTIONS = [
  { value: "residential", labelKey: "DashboardIssuance.config.propertyResidential" },
  { value: "commercial", labelKey: "DashboardIssuance.config.propertyCommercial" },
  { value: "industrial", labelKey: "DashboardIssuance.config.propertyIndustrial" },
  { value: "land", labelKey: "DashboardIssuance.config.propertyLand" },
  { value: "mixed_use", labelKey: "DashboardIssuance.config.propertyMixedUse" },
  { value: "other", labelKey: "DashboardIssuance.config.other" },
] as const;

// Shared field descriptors reused across several (category, type) sections.
const ISSUER_NAME_FIELD: FieldDescriptor = {
  key: "issuerName",
  labelKey: "DashboardIssuance.config.issuerName",
  control: "text",
  placeholderKey: "DashboardIssuance.config.issuerNamePlaceholder",
};
const PEG_CURRENCY_FIELD: FieldDescriptor = {
  key: "pegCurrency",
  labelKey: "DashboardIssuance.config.currency",
  control: "currency",
};
const PEG_TARGET_FIELD: FieldDescriptor = {
  key: "pegTarget",
  labelKey: "DashboardIssuance.config.pegTarget",
  control: "text",
  placeholderKey: "DashboardIssuance.config.pegTargetPlaceholder",
};
const REDEMPTION_FIELD: FieldDescriptor = {
  key: "redemptionEnabled",
  labelKey: "DashboardIssuance.config.redemption",
  control: "toggle",
  helpKey: "DashboardIssuance.config.redemptionHelp",
};
const JURISDICTION_FIELD: FieldDescriptor = {
  key: "jurisdiction",
  labelKey: "DashboardIssuance.config.jurisdiction",
  control: "select",
  options: JURISDICTION_OPTIONS,
};
const OFFERING_TYPE_FIELD: FieldDescriptor = {
  key: "offeringType",
  labelKey: "DashboardIssuance.config.offeringType",
  control: "select",
  options: OFFERING_OPTIONS,
};
const CUSTODIAN_FIELD: FieldDescriptor = {
  key: "custodian",
  labelKey: "DashboardIssuance.config.custodian",
  control: "text",
  placeholderKey: "DashboardIssuance.config.custodianPlaceholder",
};

// The stablecoin "Financial details" section. Reserve copy and whether a manual
// backing-type select appears depend on the variant: for fiat- and crypto-backed
// the backing is implied by the chosen sub-type (see impliedBackingType), so the
// select is omitted; the free select is only offered for a generic stablecoin.
function stablecoinFinancialSection(variant: "fiat" | "crypto" | "generic"): DetailSection {
  const backingField: FieldDescriptor[] =
    variant === "generic"
      ? [
          {
            key: "backingType",
            labelKey: "DashboardIssuance.config.backingType",
            control: "select",
            options: BACKING_OPTIONS,
          },
        ]
      : [];
  const reserveAssetField: FieldDescriptor = {
    key: "reserveAsset",
    labelKey: "DashboardIssuance.config.reserveAsset",
    control: "text",
    placeholderKey:
      variant === "crypto"
        ? "DashboardIssuance.config.reserveAssetPlaceholderCrypto"
        : "DashboardIssuance.config.reserveAssetPlaceholder",
  };
  const reserveCustodianField: FieldDescriptor = {
    key: "reserveCustodian",
    labelKey: "DashboardIssuance.config.reserveCustodian",
    control: "text",
    placeholderKey:
      variant === "crypto"
        ? "DashboardIssuance.config.reserveCustodianPlaceholderCrypto"
        : "DashboardIssuance.config.reserveCustodianPlaceholder",
  };
  return {
    titleKey: "DashboardIssuance.config.financialDetails",
    descriptionKey: "DashboardIssuance.config.financialDetailsDescription",
    fields: [
      ISSUER_NAME_FIELD,
      ...backingField,
      PEG_CURRENCY_FIELD,
      PEG_TARGET_FIELD,
      reserveAssetField,
      reserveCustodianField,
      REDEMPTION_FIELD,
    ],
  };
}

// Crypto-backed stablecoins are over-collateralized with on-chain assets valued
// by an oracle — none of which a fiat-backed reserve model captures.
const CRYPTO_COLLATERAL_SECTION: DetailSection = {
  titleKey: "DashboardIssuance.config.collateralOracleDetails",
  descriptionKey: "DashboardIssuance.config.collateralOracleDetailsDescription",
  fields: [
    {
      key: "collateralizationRatio",
      labelKey: "DashboardIssuance.config.collateralizationRatio",
      control: "number",
      placeholderKey: "DashboardIssuance.config.collateralizationRatioPlaceholder",
      helpKey: "DashboardIssuance.config.collateralizationRatioHelp",
    },
    {
      key: "oracleProvider",
      labelKey: "DashboardIssuance.config.oracleProvider",
      control: "text",
      placeholderKey: "DashboardIssuance.config.oracleProviderPlaceholder",
    },
    {
      key: "minCollateralRatio",
      labelKey: "DashboardIssuance.config.minCollateralRatio",
      control: "number",
      placeholderKey: "DashboardIssuance.config.minCollateralRatioPlaceholder",
      helpKey: "DashboardIssuance.config.minCollateralRatioHelp",
    },
  ],
};

const SECURITY_BASE_FIELDS: readonly FieldDescriptor[] = [
  ISSUER_NAME_FIELD,
  JURISDICTION_FIELD,
  OFFERING_TYPE_FIELD,
];

const EQUITY_TERMS_SECTION: DetailSection = {
  titleKey: "DashboardIssuance.config.equityDetails",
  descriptionKey: "DashboardIssuance.config.equityDetailsDescription",
  fields: [
    {
      key: "shareClass",
      labelKey: "DashboardIssuance.config.shareClass",
      control: "text",
      placeholderKey: "DashboardIssuance.config.shareClassPlaceholder",
    },
    {
      key: "votingRights",
      labelKey: "DashboardIssuance.config.votingRights",
      control: "toggle",
      helpKey: "DashboardIssuance.config.votingRightsHelp",
    },
  ],
};

const DEBT_TERMS_SECTION: DetailSection = {
  titleKey: "DashboardIssuance.config.debtDetails",
  descriptionKey: "DashboardIssuance.config.debtDetailsDescription",
  fields: [
    {
      key: "couponRate",
      labelKey: "DashboardIssuance.config.couponRate",
      control: "text",
      placeholderKey: "DashboardIssuance.config.couponRatePlaceholder",
    },
    {
      key: "maturityDate",
      labelKey: "DashboardIssuance.config.maturityDate",
      control: "text",
      placeholderKey: "DashboardIssuance.config.maturityDatePlaceholder",
    },
    {
      key: "seniority",
      labelKey: "DashboardIssuance.config.seniority",
      control: "select",
      options: SENIORITY_OPTIONS,
    },
  ],
};

const FUND_TERMS_SECTION: DetailSection = {
  titleKey: "DashboardIssuance.config.fundDetails",
  descriptionKey: "DashboardIssuance.config.fundDetailsDescription",
  fields: [
    {
      key: "fundStrategy",
      labelKey: "DashboardIssuance.config.fundStrategy",
      control: "select",
      options: FUND_STRATEGY_OPTIONS,
    },
    {
      key: "managementFee",
      labelKey: "DashboardIssuance.config.managementFee",
      control: "text",
      placeholderKey: "DashboardIssuance.config.managementFeePlaceholder",
    },
    {
      key: "netAssetValue",
      labelKey: "DashboardIssuance.config.netAssetValue",
      control: "text",
      placeholderKey: "DashboardIssuance.config.netAssetValuePlaceholder",
    },
  ],
};

function securitySections(...extra: DetailSection[]): readonly DetailSection[] {
  return [
    {
      titleKey: "DashboardIssuance.config.securityDetails",
      descriptionKey: "DashboardIssuance.config.securityDetailsDescription",
      fields: SECURITY_BASE_FIELDS,
    },
    ...extra,
  ];
}

// Generic (non-security) asset details, tuned per sub-type. The commodity and
// collectible forms share the "underlying asset + custodian" shape but with
// different copy; real estate swaps in property type + location.
function genericAssetSection(variant: "commodity" | "collectible" | "default"): DetailSection {
  return {
    titleKey: "DashboardIssuance.config.categoryAssetDetails",
    descriptionKey: "DashboardIssuance.config.categoryAssetDetailsDescription",
    fields: [
      {
        key: "underlyingAsset",
        labelKey: "DashboardIssuance.config.underlyingAsset",
        control: "text",
        placeholderKey:
          variant === "collectible"
            ? "DashboardIssuance.config.underlyingAssetPlaceholderCollectible"
            : "DashboardIssuance.config.underlyingAssetPlaceholder",
      },
      {
        key: "custodian",
        labelKey: "DashboardIssuance.config.custodian",
        control: "text",
        placeholderKey:
          variant === "collectible"
            ? "DashboardIssuance.config.custodianPlaceholderCollectible"
            : "DashboardIssuance.config.custodianPlaceholder",
      },
    ],
  };
}

const REAL_ESTATE_SECTION: DetailSection = {
  titleKey: "DashboardIssuance.config.realEstateDetails",
  descriptionKey: "DashboardIssuance.config.realEstateDetailsDescription",
  fields: [
    {
      key: "propertyType",
      labelKey: "DashboardIssuance.config.propertyType",
      control: "select",
      options: PROPERTY_TYPE_OPTIONS,
    },
    {
      key: "propertyLocation",
      labelKey: "DashboardIssuance.config.propertyLocation",
      control: "text",
      placeholderKey: "DashboardIssuance.config.propertyLocationPlaceholder",
    },
    {
      ...CUSTODIAN_FIELD,
      placeholderKey: "DashboardIssuance.config.custodianPlaceholderRealEstate",
    },
  ],
};

// The default sections for a category (used for a registry type the taxonomy
// doesn't surface a bespoke form for, e.g. a "generic" sub-type).
const DEFAULT_SECTIONS: Record<AssetCategory, readonly DetailSection[]> = {
  stablecoin: [stablecoinFinancialSection("generic")],
  tokenized_security: securitySections(),
  generic: [genericAssetSection("default")],
};

// Per (category, type) sections. A type absent here falls back to the category's
// DEFAULT_SECTIONS. Every field's select options are enumerated below for the
// value→label lookup, so keep new options on descriptors reachable from here.
const TYPE_SECTIONS: Record<AssetCategory, Record<string, readonly DetailSection[]>> = {
  stablecoin: {
    fiat_backed: [stablecoinFinancialSection("fiat")],
    crypto_backed: [stablecoinFinancialSection("crypto"), CRYPTO_COLLATERAL_SECTION],
  },
  tokenized_security: {
    equity: securitySections(EQUITY_TERMS_SECTION),
    debt: securitySections(DEBT_TERMS_SECTION),
    fund: securitySections(FUND_TERMS_SECTION),
  },
  generic: {
    commodity: [genericAssetSection("commodity")],
    real_estate: [REAL_ESTATE_SECTION],
    collectible: [genericAssetSection("collectible")],
  },
};

// The detail sections for a (category, type) selection. Falls back to the
// category default before a type is chosen or for an unmodelled type.
export function getDetailSections(
  category: AssetCategory | null,
  type: string | null
): readonly DetailSection[] {
  if (!category) {
    return [];
  }
  const byType = TYPE_SECTIONS[category] ?? {};
  return (type ? byType[type] : undefined) ?? DEFAULT_SECTIONS[category] ?? [];
}

// Whether a (category, type) detail form includes a given field. Drives review /
// summary conditionals (e.g. "only show issuer name for types that collect it").
export function detailSectionsHaveField(
  category: AssetCategory | null,
  type: string | null,
  key: DetailFieldKey
): boolean {
  return getDetailSections(category, type).some((section) =>
    section.fields.some((field) => field.key === key)
  );
}

// The backing type implied by a stablecoin sub-type — fiat_backed → "fiat",
// crypto_backed → "crypto". Returns null when the backing isn't implied (generic
// stablecoin, or any non-stablecoin), where the value is issuer-entered instead.
// This keeps asset.backingType consistent with the chosen type rather than
// letting a free select contradict it.
export function impliedBackingType(
  category: AssetCategory | null,
  type: string | null
): string | null {
  if (category !== "stablecoin") {
    return null;
  }
  if (type === "fiat_backed") {
    return "fiat";
  }
  if (type === "crypto_backed") {
    return "crypto";
  }
  return null;
}

// The concise "pegged to" descriptor for the summary/review, or null when the
// asset has no peg. Prefers the explicit peg/target text (e.g. "1.00 USD",
// "1 oz Gold") and falls back to the selected currency (e.g. "USD").
export function getPegSummary(
  draft: Pick<DraftState, "assetCategory" | "assetType" | "pegCurrency" | "pegTarget">
): string | null {
  if (!detailSectionsHaveField(draft.assetCategory, draft.assetType, "pegCurrency")) {
    return null;
  }
  return draft.pegTarget.trim() || draft.pegCurrency.trim() || null;
}

// value -> label per select-backed field, derived from every (category, type)
// section. Later sections win on key collisions, but the shared option sets
// (backing, jurisdiction, …) are identical wherever they appear, so a flat merge
// is safe.
const OPTION_LABELS_BY_KEY: Partial<Record<DetailFieldKey, Record<string, MessageKey>>> = {};
for (const byType of Object.values(TYPE_SECTIONS)) {
  for (const sections of Object.values(byType)) {
    for (const section of sections) {
      for (const field of section.fields) {
        if (field.options) {
          OPTION_LABELS_BY_KEY[field.key] = Object.fromEntries(
            field.options.map((option) => [option.value, option.labelKey])
          );
        }
      }
    }
  }
}
// The generic-stablecoin backing select only lives in DEFAULT_SECTIONS, so pick
// it up explicitly for the value→label lookup (used by the public-info preview).
OPTION_LABELS_BY_KEY.backingType = Object.fromEntries(
  BACKING_OPTIONS.map((option) => [option.value, option.labelKey])
);

// Human label for a select-backed field's stored value (e.g. backingType
// "fiat" -> "Fiat-backed"). Undefined for free-text fields or unknown values,
// so callers can fall back to the raw value.
export function detailFieldOptionLabel(
  key: string,
  value: string,
  t: Translate
): string | undefined {
  const labelKey = OPTION_LABELS_BY_KEY[key as DetailFieldKey]?.[value];
  return labelKey ? t(labelKey) : undefined;
}

export const ACCESS_CONTROL_OPTIONS: readonly { value: AccessControlMode; labelKey: MessageKey }[] =
  [
    { value: "allowlist", labelKey: "DashboardIssuance.config.allowList" },
    { value: "blocklist", labelKey: "DashboardIssuance.config.blockList" },
    { value: "disabled", labelKey: "DashboardIssuance.wallet.none" },
  ];

export function getDefaultAccessControl(category: AssetCategory): AccessControlMode {
  switch (category) {
    case "tokenized_security":
      return "allowlist";
    case "stablecoin":
      return "blocklist";
    default:
      return "disabled";
  }
}

export const CAPACITY_META: Record<
  CapacityKey,
  { labelKey: MessageKey; descriptionKey: MessageKey }
> = {
  kyc: {
    labelKey: "DashboardIssuance.config.kyc",
    descriptionKey: "DashboardIssuance.config.kycDescription",
  },
  restrictTradingHours: {
    labelKey: "DashboardIssuance.config.restrictTradingHours",
    descriptionKey: "DashboardIssuance.config.restrictTradingHoursDescription",
  },
  issueRetireControls: {
    labelKey: "DashboardIssuance.config.issueRetireControls",
    descriptionKey: "DashboardIssuance.config.issueRetireControlsDescription",
  },
  redemptionApprovals: {
    labelKey: "DashboardIssuance.config.redemptionApprovals",
    descriptionKey: "DashboardIssuance.config.redemptionApprovalsDescription",
  },
  investorReporting: {
    labelKey: "DashboardIssuance.config.investorReporting",
    descriptionKey: "DashboardIssuance.config.investorReportingDescription",
  },
  transferApprovals: {
    labelKey: "DashboardIssuance.config.transferApprovals",
    descriptionKey: "DashboardIssuance.config.transferApprovalsDescription",
  },
};

// Recommended capacities pre-selected when a sub-asset type is chosen (the
// sketch's "Recommended capacities are pre-selected based on asset profile").
export function getRecommendedCapacities(
  category: AssetCategory,
  type: string
): Record<CapacityKey, boolean> {
  const caps = createInitialCapacities();
  caps.kyc = true;
  caps.issueRetireControls = true;
  if (category === "stablecoin") {
    caps.restrictTradingHours = type === "fiat_backed";
  }
  if (category === "tokenized_security") {
    caps.investorReporting = true;
    caps.transferApprovals = true;
  }
  return caps;
}

// Human label for an access-control mode (used in summary/review).
export function accessControlLabel(mode: DraftState["accessControl"], t: Translate): string | null {
  switch (mode) {
    case "allowlist":
      return t("DashboardIssuance.config.allowList");
    case "blocklist":
      return t("DashboardIssuance.config.blockList");
    case "disabled":
      return t("DashboardIssuance.wallet.none");
    default:
      return null;
  }
}
