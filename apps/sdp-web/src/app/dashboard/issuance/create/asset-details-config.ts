import type { AssetCategory } from "@sdp/types";
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
  label: string;
  control: FieldControl;
  placeholder?: string;
  help?: string;
  options?: readonly { value: string; label: string }[];
}

export interface DetailSection {
  title: string;
  description?: string;
  fields: readonly FieldDescriptor[];
}

const JURISDICTION_OPTIONS = [
  { value: "us", label: "United States" },
  { value: "eu", label: "European Union" },
  { value: "uk", label: "United Kingdom" },
  { value: "sg", label: "Singapore" },
  { value: "other", label: "Other" },
] as const;

const OFFERING_OPTIONS = [
  { value: "reg_d", label: "Reg D" },
  { value: "reg_s", label: "Reg S" },
  { value: "reg_a", label: "Reg A+" },
  { value: "public", label: "Public offering" },
  { value: "other", label: "Other" },
] as const;

const BACKING_OPTIONS = [
  { value: "fiat", label: "Fiat-backed" },
  { value: "crypto", label: "Crypto-backed" },
  { value: "commodity", label: "Commodity-backed" },
  { value: "algorithmic", label: "Algorithmic" },
] as const;

// Category-specific sections shown in the Overview tab, below the common "About"
// block. Add/remove per asset here.
const CATEGORY_SECTIONS: Record<AssetCategory, readonly DetailSection[]> = {
  stablecoin: [
    {
      title: "Financial details",
      description: "Key financial attributes of the asset.",
      fields: [
        {
          key: "issuerName",
          label: "Issuer name",
          control: "text",
          placeholder: "e.g., Acme Financial Inc.",
        },
        { key: "backingType", label: "Backing type", control: "select", options: BACKING_OPTIONS },
        { key: "pegCurrency", label: "Currency", control: "currency" },
        { key: "pegTarget", label: "Peg or target", control: "text", placeholder: "1.00 USD" },
        {
          key: "reserveAsset",
          label: "Reserve asset",
          control: "text",
          placeholder: "USD (U.S. Dollar)",
        },
        {
          key: "reserveCustodian",
          label: "Reserve custodian",
          control: "text",
          placeholder: "e.g., Acme Treasury Ltd.",
        },
        {
          key: "redemptionEnabled",
          label: "Redemption",
          control: "toggle",
          help: "Holders can redeem tokens for the underlying reserves.",
        },
      ],
    },
  ],
  tokenized_security: [
    {
      title: "Security details",
      description: "Issuer and offering information.",
      fields: [
        {
          key: "issuerName",
          label: "Issuer name",
          control: "text",
          placeholder: "e.g., Acme Financial Inc.",
        },
        {
          key: "jurisdiction",
          label: "Jurisdiction",
          control: "select",
          options: JURISDICTION_OPTIONS,
        },
        {
          key: "offeringType",
          label: "Offering type",
          control: "select",
          options: OFFERING_OPTIONS,
        },
      ],
    },
  ],
  generic: [
    {
      title: "Asset details",
      description: "What backs or represents this asset.",
      fields: [
        {
          key: "underlyingAsset",
          label: "Underlying asset",
          control: "text",
          placeholder: "e.g., Gold, real estate",
        },
        {
          key: "custodian",
          label: "Custodian",
          control: "text",
          placeholder: "e.g., Acme Custody",
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
          field.options.map((option) => [option.value, option.label])
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

export const ACCESS_CONTROL_OPTIONS: readonly { value: AccessControlMode; label: string }[] = [
  { value: "allowlist", label: "Allow list" },
  { value: "blocklist", label: "Block list" },
  { value: "disabled", label: "None" },
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

export const CAPACITY_META: Record<CapacityKey, { label: string; description: string }> = {
  kyc: {
    label: "KYC",
    description: "Require identity verification before users can hold or transfer tokens.",
  },
  restrictTradingHours: {
    label: "Restrict trading hours",
    description: "Limit token transfers to specific days and time windows.",
  },
  freezeTransfers: {
    label: "Freeze transfers",
    description: "Freeze tokens in response to compliance events or investigations.",
  },
  issueRetireControls: {
    label: "Issue & retire controls",
    description: "Control who can issue new tokens or retire existing supply.",
  },
  redemptionApprovals: {
    label: "Redemption approvals",
    description: "Require approval before redeeming tokens for underlying reserves.",
  },
  investorReporting: {
    label: "Investor reporting",
    description: "Generate periodic reports for investors and stakeholders.",
  },
  transferApprovals: {
    label: "Transfer approvals",
    description: "Require approval for transfers above a set threshold.",
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
