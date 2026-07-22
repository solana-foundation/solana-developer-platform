import type { AssetCategory } from "@sdp/types";

// The four top-level wizard steps (V2 issuance direction). Classification owns
// both the category and the sub-asset-type selection; "asset-details" is the
// detail form only.
export const WIZARD_STEPS = ["classification", "asset-details", "public-info", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardStepMeta {
  id: WizardStep;
}

export const WIZARD_STEP_META: readonly WizardStepMeta[] = [
  { id: "classification" },
  { id: "asset-details" },
  { id: "public-info" },
  { id: "review" },
];

export type AccessControlMode = "allowlist" | "blocklist" | "disabled";

// Off-chain compliance capacities (the "Advanced (Recommended)" collapse). Stored
// under compliance.capacities.* in the issuance metadata. On-chain, extension-
// backed controls (e.g. freeze via the pausable extension) live in the advanced
// settings editor instead (issuance_metadata.settings), not here.
export const CAPACITY_KEYS = [
  "kyc",
  "restrictTradingHours",
  "issueRetireControls",
  "redemptionApprovals",
  "investorReporting",
  "transferApprovals",
] as const;
export type CapacityKey = (typeof CAPACITY_KEYS)[number];

// Selected advanced (Token-2022) settings, keyed by settingKey from the
// @sdp/issuance/capabilities catalog. Presence = enabled; `params` holds expert
// override values as strings (form inputs). Persisted under
// issuance_metadata.settings.selected.
export type AdvancedSettingsDraft = Record<string, { params?: Record<string, string> }>;

export interface DocumentRow {
  id: string;
  docType: string;
  name: string;
  url: string;
}

export interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

// The complete form model: every value a user can enter across all four steps.
// Fields owned by a step start empty so the whole object can be persisted and
// restored as one unit.
export interface DraftState {
  // Step 1 — classification
  assetCategory: AssetCategory | null;
  assetType: string | null;
  name: string;
  // Step 2 — identity + "about"
  symbol: string;
  decimals: string;
  description: string;
  website: string;
  imageUrl: string;
  // Step 2 — stablecoin financial details
  backingType: string;
  pegCurrency: string;
  pegTarget: string;
  reserveAsset: string;
  reserveCustodian: string;
  redemptionEnabled: boolean;
  // Step 2 — tokenized-security details
  issuerName: string;
  jurisdiction: string;
  offeringType: string;
  // Step 2 — non-security digital asset details
  underlyingAsset: string;
  custodian: string;
  // Step 2 — documents & references
  documents: DocumentRow[];
  // Step 2 — compliance & access
  accessControl: AccessControlMode | "";
  capacities: Record<CapacityKey, boolean>;
  // Step 2 — advanced (on-chain) settings (issuance_metadata.settings)
  advancedSettings: AdvancedSettingsDraft;
  // Step 2 — operational
  signingWalletId: string;
  metadataUri: string;
  // Step 2 — custom fields (custom.customer.*)
  customFields: CustomFieldRow[];
  // Step 3 — public metadata visibility: the issuance_metadata dot-paths the
  // issuer publishes (e.g. "asset.issuerName"). Persisted as
  // issuance_metadata.visibility.public; preselected per asset type.
  publicFields: string[];
}

export function createInitialCapacities(): Record<CapacityKey, boolean> {
  return {
    kyc: false,
    restrictTradingHours: false,
    issueRetireControls: false,
    redemptionApprovals: false,
    investorReporting: false,
    transferApprovals: false,
  };
}

export function createInitialDraft(): DraftState {
  return {
    assetCategory: null,
    assetType: null,
    name: "",
    symbol: "",
    decimals: "",
    description: "",
    website: "",
    imageUrl: "",
    backingType: "",
    pegCurrency: "",
    pegTarget: "",
    reserveAsset: "",
    reserveCustodian: "",
    redemptionEnabled: false,
    issuerName: "",
    jurisdiction: "",
    offeringType: "",
    underlyingAsset: "",
    custodian: "",
    documents: [],
    accessControl: "",
    capacities: createInitialCapacities(),
    advancedSettings: {},
    signingWalletId: "",
    metadataUri: "",
    customFields: [],
    publicFields: [],
  };
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function isValidDecimals(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 18;
}

// Coarse per-step completion — used for step reachability, the progress header,
// and clamping a restored step on hydrate.
export function isStepComplete(step: WizardStep, draft: DraftState): boolean {
  switch (step) {
    case "classification":
      return (
        draft.assetCategory !== null && draft.assetType !== null && draft.name.trim().length > 0
      );
    case "asset-details":
      return draft.symbol.trim().length > 0 && isValidDecimals(draft.decimals);
    case "public-info":
      return true;
    case "review":
      return false;
    default:
      return false;
  }
}

// Fine-grained gate for the footer "Continue" button.
export function canAdvance(step: WizardStep, draft: DraftState): boolean {
  switch (step) {
    case "classification":
      return (
        draft.assetCategory !== null && draft.assetType !== null && draft.name.trim().length > 0
      );
    case "asset-details":
      return draft.symbol.trim().length > 0 && isValidDecimals(draft.decimals);
    case "public-info":
      return true;
    case "review":
      return true;
    default:
      return false;
  }
}

// The furthest step the user may legitimately sit on given the current draft:
// every step before it must be complete.
export function furthestReachableStep(draft: DraftState): WizardStep {
  let reachable: WizardStep = "classification";
  for (let i = 1; i < WIZARD_STEPS.length; i += 1) {
    if (!isStepComplete(WIZARD_STEPS[i - 1], draft)) {
      break;
    }
    reachable = WIZARD_STEPS[i];
  }
  return reachable;
}
