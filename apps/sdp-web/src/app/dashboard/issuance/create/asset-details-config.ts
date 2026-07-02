import type { AssetCategory } from "@sdp/types";
import {
  type AccessControlMode,
  type CapacityKey,
  createInitialCapacities,
  type DraftState,
} from "./issuance-draft-wizard.types";

// Presentation config for the Step-2 "Asset details" form. Category-aware so
// different assets show different fields (the sketch is stablecoin-shaped).

export type FieldControl = "text" | "textarea" | "number" | "select" | "toggle";

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

const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "JPY", label: "JPY" },
  { value: "SGD", label: "SGD" },
] as const;

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
        { key: "pegCurrency", label: "Currency", control: "select", options: CURRENCY_OPTIONS },
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
