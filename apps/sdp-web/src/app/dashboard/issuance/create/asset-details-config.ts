import type { AssetCategory } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import {
  type AccessControlMode,
  type CapacityKey,
  createInitialCapacities,
  type DraftState,
} from "./issuance-draft-wizard.types";

// Presentation config for the Step-2 "Asset details" form. Category-aware so
// different assets show different fields (the sketch is stablecoin-shaped).

export type FieldControl = "text" | "textarea" | "number" | "select" | "toggle" | "currency";

// DraftState keys editable through a category detail section.
export type DetailFieldKey =
  | "backingType"
  | "pegCurrency"
  | "pegTarget"
  | "reserveAsset"
  | "reserveCustodian"
  | "redemptionEnabled"
  | "issuerName"
  | "jurisdiction"
  | "offeringType"
  | "underlyingAsset"
  | "custodian";

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

// Category-specific sections shown in the Overview tab, below the common "About"
// block. Add/remove per asset here.
const CATEGORY_SECTIONS: Record<AssetCategory, readonly DetailSection[]> = {
  stablecoin: [
    {
      titleKey: "DashboardIssuance.config.financialDetails",
      descriptionKey: "DashboardIssuance.config.financialDetailsDescription",
      fields: [
        {
          key: "issuerName",
          labelKey: "DashboardIssuance.config.issuerName",
          control: "text",
          placeholderKey: "DashboardIssuance.config.issuerNamePlaceholder",
        },
        {
          key: "backingType",
          labelKey: "DashboardIssuance.config.backingType",
          control: "select",
          options: BACKING_OPTIONS,
        },
        { key: "pegCurrency", labelKey: "DashboardIssuance.config.currency", control: "currency" },
        {
          key: "pegTarget",
          labelKey: "DashboardIssuance.config.pegTarget",
          control: "text",
          placeholderKey: "DashboardIssuance.config.pegTargetPlaceholder",
        },
        {
          key: "reserveAsset",
          labelKey: "DashboardIssuance.config.reserveAsset",
          control: "text",
          placeholderKey: "DashboardIssuance.config.reserveAssetPlaceholder",
        },
        {
          key: "reserveCustodian",
          labelKey: "DashboardIssuance.config.reserveCustodian",
          control: "text",
          placeholderKey: "DashboardIssuance.config.reserveCustodianPlaceholder",
        },
        {
          key: "redemptionEnabled",
          labelKey: "DashboardIssuance.config.redemption",
          control: "toggle",
          helpKey: "DashboardIssuance.config.redemptionHelp",
        },
      ],
    },
  ],
  tokenized_security: [
    {
      titleKey: "DashboardIssuance.config.securityDetails",
      descriptionKey: "DashboardIssuance.config.securityDetailsDescription",
      fields: [
        {
          key: "issuerName",
          labelKey: "DashboardIssuance.config.issuerName",
          control: "text",
          placeholderKey: "DashboardIssuance.config.issuerNamePlaceholder",
        },
        {
          key: "jurisdiction",
          labelKey: "DashboardIssuance.config.jurisdiction",
          control: "select",
          options: JURISDICTION_OPTIONS,
        },
        {
          key: "offeringType",
          labelKey: "DashboardIssuance.config.offeringType",
          control: "select",
          options: OFFERING_OPTIONS,
        },
      ],
    },
  ],
  generic: [
    {
      titleKey: "DashboardIssuance.config.categoryAssetDetails",
      descriptionKey: "DashboardIssuance.config.categoryAssetDetailsDescription",
      fields: [
        {
          key: "underlyingAsset",
          labelKey: "DashboardIssuance.config.underlyingAsset",
          control: "text",
          placeholderKey: "DashboardIssuance.config.underlyingAssetPlaceholder",
        },
        {
          key: "custodian",
          labelKey: "DashboardIssuance.config.custodian",
          control: "text",
          placeholderKey: "DashboardIssuance.config.custodianPlaceholder",
        },
      ],
    },
  ],
};

export function getCategorySections(category: AssetCategory | null): readonly DetailSection[] {
  if (!category) {
    return [];
  }
  return CATEGORY_SECTIONS[category] ?? [];
}

// True when the category's detail form collects peg/currency fields (stablecoins
// today). Peg values persist on the draft across category changes, so callers
// use this to avoid surfacing a stale peg on an asset that isn't pegged.
export function categoryCollectsPeg(category: AssetCategory | null): boolean {
  return getCategorySections(category).some((section) =>
    section.fields.some((field) => field.key === "pegCurrency" || field.key === "pegTarget")
  );
}

// The concise "pegged to" descriptor for the summary/review, or null when the
// asset has no peg. Prefers the explicit peg/target text (e.g. "1.00 USD",
// "1 oz Gold") and falls back to the selected currency (e.g. "USD").
export function getPegSummary(
  draft: Pick<DraftState, "assetCategory" | "pegCurrency" | "pegTarget">
): string | null {
  if (!categoryCollectsPeg(draft.assetCategory)) {
    return null;
  }
  return draft.pegTarget.trim() || draft.pegCurrency.trim() || null;
}

// value -> label per select-backed field, derived from every category's field
// options. Keys are unique across categories today, so a flat merge is safe.
const OPTION_LABELS_BY_KEY: Partial<Record<DetailFieldKey, Record<string, string>>> = {};
for (const sections of Object.values(CATEGORY_SECTIONS)) {
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.options) {
        OPTION_LABELS_BY_KEY[field.key] = Object.fromEntries(
          field.options.map((option) => [option.value, option.value])
        );
      }
    }
  }
}

// Human label for a select-backed field's stored value (e.g. backingType
// "fiat" -> "Fiat-backed"). Undefined for free-text fields or unknown values,
// so callers can fall back to the raw value.
export function detailFieldOptionLabel(key: string, value: string): string | undefined {
  return OPTION_LABELS_BY_KEY[key as DetailFieldKey]?.[value];
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
  freezeTransfers: {
    labelKey: "DashboardIssuance.config.freezeTransfers",
    descriptionKey: "DashboardIssuance.config.freezeTransfersDescription",
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
  caps.freezeTransfers = true;
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
export function accessControlLabel(mode: DraftState["accessControl"]): string | null {
  switch (mode) {
    case "allowlist":
      return "Allow list";
    case "blocklist":
      return "Block list";
    case "disabled":
      return "None";
    default:
      return null;
  }
}
