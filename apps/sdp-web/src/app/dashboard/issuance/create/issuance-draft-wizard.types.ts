import type { AssetCategory } from "@sdp/types";

// The four top-level wizard steps (V2 issuance direction). The sub-asset-type
// screen lives under "asset-details" together with the fuller detail form.
export const WIZARD_STEPS = ["classification", "asset-details", "public-info", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardStepMeta {
  id: WizardStep;
  title: string;
  description: string;
}

export const WIZARD_STEP_META: readonly WizardStepMeta[] = [
  {
    id: "classification",
    title: "What is this asset?",
    description: "Define the asset and its classification",
  },
  {
    id: "asset-details",
    title: "Asset details",
    description: "Provide key information and settings",
  },
  {
    id: "public-info",
    title: "Public information",
    description: "Review what will be made public",
  },
  { id: "review", title: "Review & finish", description: "Confirm and create draft" },
];

// The complete form model: every value a user can enter across all four steps.
// Fields owned by later (not-yet-built) steps start empty so the whole thing can
// be persisted and restored as one object.
export interface DraftState {
  // Step 1 — classification
  assetCategory: AssetCategory | null;
  assetType: string | null;
  name: string;
  // Step 2+ — asset details (empty until their steps are built)
  symbol: string;
  decimals: string;
  issuerName: string;
  pegCurrency: string;
  accessControl: string;
  transferRestrictions: string;
  investorReporting: string;
  website: string;
  // Namespaced customer custom fields (custom.customer.*), private by default.
  customFields: Record<string, string>;
}

export function createInitialDraft(): DraftState {
  return {
    assetCategory: null,
    assetType: null,
    name: "",
    symbol: "",
    decimals: "",
    issuerName: "",
    pegCurrency: "",
    accessControl: "",
    transferRestrictions: "",
    investorReporting: "",
    website: "",
    customFields: {},
  };
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

// A step is "complete" once its required inputs are filled. Used both to gate the
// footer Continue button and to clamp the restored step on hydrate so a stale
// localStorage entry can never drop the user onto Review with an empty draft.
export function isStepComplete(step: WizardStep, draft: DraftState): boolean {
  switch (step) {
    case "classification":
      return draft.assetCategory !== null && draft.name.trim().length > 0;
    case "asset-details":
      return draft.assetType !== null;
    case "public-info":
      return true;
    case "review":
      return false;
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
