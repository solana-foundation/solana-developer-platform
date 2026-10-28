import type { AssetCategory } from "@sdp/types/asset-profiles";

export type AccessControlMode = "allowlist" | "blocklist" | "disabled";

// Off-chain compliance capacities (the "Advanced (Recommended)" collapse). Stored
// under compliance.capacities.* in the issuance metadata. On-chain, extension-
// backed controls (e.g. freeze via the pausable extension) live in the advanced
// settings editor instead (issuance_metadata.settings), not here.
// Display order: the checkbox-only policies (kyc, issueRetireControls) come
// first, then the configurable ones, so simple toggles aren't interleaved with
// rows that carry a Configure affordance.
export const CAPACITY_KEYS = [
  "kyc",
  "issueRetireControls",
  "restrictTradingHours",
  "redemptionApprovals",
  "investorReporting",
  "transferApprovals",
] as const;
export type CapacityKey = (typeof CAPACITY_KEYS)[number];

// --- Per-policy configuration -------------------------------------------------
// Off-chain policies are policy objects, not scalars. Two layers: enabling a
// policy (the checkbox — the *declaration* layer, what presets compose) is
// separate from configuring how it works (the *config* layer, edited in the
// per-policy modal on the asset-profile compliance tab). Config is heterogeneous
// per capacity and always optional — a capacity may be enabled but not yet
// configured (surfaced as a readiness item).

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];
export type TradingHoursSchedule = "24_7" | "market_hours" | "custom";

export interface TradingHoursConfig {
  schedule: TradingHoursSchedule;
  // Only meaningful for the "custom" schedule: the open days and the daily
  // window (local to `timezone`). "HH:MM" 24-hour strings.
  days?: Weekday[];
  open?: string;
  close?: string;
  timezone?: string; // IANA tz id, e.g. "America/New_York".
}

export type TransferApprovalRule = "all" | "above_amount" | "new_counterparty";
export interface TransferApprovalsConfig {
  rule: TransferApprovalRule;
  // Only for "above_amount": threshold in whole tokens (string; may exceed 2^53).
  amount?: string;
  // Approver wallets/roles — a roster that may stay empty until wallets exist.
  approvers?: string[];
}

// Redemptions redeem against reserves, so the rule keys off amount (not a
// counterparty). Mirrors transfer approvals otherwise.
export type RedemptionApprovalRule = "all" | "above_amount";
export interface RedemptionApprovalsConfig {
  rule: RedemptionApprovalRule;
  amount?: string;
  approvers?: string[];
}

export type ReportingCadence = "monthly" | "quarterly" | "annual";
export type ReportingFormat = "pdf" | "csv" | "xlsx";
export interface InvestorReportingConfig {
  cadence: ReportingCadence;
  format?: ReportingFormat;
  // Report recipients (emails/names) — a roster that may stay empty until the
  // investor set exists.
  recipients?: string[];
}

// The config payload for a capacity that supports one. Absent config = enabled
// but unconfigured. Narrowed by capacity key at the modal edge.
export type CapacityConfig =
  | TradingHoursConfig
  | TransferApprovalsConfig
  | RedemptionApprovalsConfig
  | InvestorReportingConfig;

// A single off-chain capacity selection. Mirrors the on-chain SelectedSetting
// ({ params? }) so the whole compliance selection persists in one payload
// (issuance_metadata.compliance.capacities).
export interface CapacitySelection {
  enabled: boolean;
  config?: CapacityConfig;
}

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
  // Step 2 — supply cap. SPL/Token-2022 have no supply-cap field, so this is an
  // SDP policy limit enforced by our mint endpoint only. Empty = uncapped. A true
  // on-chain cap requires minting to the cap and then revoking the mint authority
  // (the asset workspace's "lock supply" action).
  //
  // The mint's freeze authority is NOT here: it is the "freezeAccounts" advanced
  // setting, so it lives in `advancedSettings` alongside its pausable sibling.
  maxSupply: string;
  // Step 2 — stablecoin financial details
  backingType: string;
  pegCurrency: string;
  pegTarget: string;
  reserveAsset: string;
  reserveCustodian: string;
  redemptionEnabled: boolean;
  // Step 2 — crypto-backed stablecoin collateral & oracle (over-collateralized,
  // on-chain backing rather than off-chain fiat reserves)
  collateralizationRatio: string;
  oracleProvider: string;
  minCollateralRatio: string;
  // Step 2 — tokenized-security details
  issuerName: string;
  jurisdiction: string;
  offeringType: string;
  // Step 2 — tokenized-security instrument terms (per sub-type: equity / debt /
  // fund)
  shareClass: string;
  votingRights: boolean;
  couponRate: string;
  maturityDate: string;
  seniority: string;
  fundStrategy: string;
  managementFee: string;
  netAssetValue: string;
  // Step 2 — non-security digital asset details
  underlyingAsset: string;
  custodian: string;
  // Step 2 — tokenized real-estate details
  propertyType: string;
  propertyLocation: string;
  // Step 2 — documents & references
  documents: DocumentRow[];
  // Step 2 — compliance & access
  accessControl: AccessControlMode | "";
  capacities: Record<CapacityKey, CapacitySelection>;
  // Step 2 — advanced (on-chain) settings (issuance_metadata.settings)
  advancedSettings: AdvancedSettingsDraft;
  // Step 2 — operational
  signingWalletId: string;
  authorityWalletIds?: Record<string, string>;
  metadataUri: string;
  // Step 2 — custom fields (custom.customer.*)
  customFields: CustomFieldRow[];
  // Step 3 — public metadata visibility: the issuance_metadata dot-paths the
  // issuer publishes (e.g. "asset.issuerName"). Persisted as
  // issuance_metadata.visibility.public; preselected per asset type.
  publicFields: string[];
}

export function createInitialCapacities(): Record<CapacityKey, CapacitySelection> {
  return {
    kyc: { enabled: false },
    restrictTradingHours: { enabled: false },
    issueRetireControls: { enabled: false },
    redemptionApprovals: { enabled: false },
    investorReporting: { enabled: false },
    transferApprovals: { enabled: false },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalize a persisted capacities map to the current { enabled, config? } shape,
// tolerating the legacy bare-boolean encoding ({ kyc: true }). The single coercion
// point shared by every hydration path (wizard localStorage + asset-profile DB), so
// an old payload never reaches the UI as a raw boolean (which would make the toggle
// an uncontrolled input).
export function coerceCapacities(value: unknown): Record<CapacityKey, CapacitySelection> {
  const capacities = createInitialCapacities();
  if (isPlainObject(value)) {
    for (const key of CAPACITY_KEYS) {
      const raw = value[key];
      if (raw === true) {
        capacities[key] = { enabled: true };
      } else if (isPlainObject(raw) && raw.enabled === true) {
        capacities[key] = {
          enabled: true,
          config: isPlainObject(raw.config) ? (raw.config as unknown as CapacityConfig) : undefined,
        };
      }
    }
  }
  return capacities;
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
    maxSupply: "",
    backingType: "",
    pegCurrency: "",
    pegTarget: "",
    reserveAsset: "",
    reserveCustodian: "",
    redemptionEnabled: false,
    collateralizationRatio: "",
    oracleProvider: "",
    minCollateralRatio: "",
    issuerName: "",
    jurisdiction: "",
    offeringType: "",
    shareClass: "",
    votingRights: false,
    couponRate: "",
    maturityDate: "",
    seniority: "",
    fundStrategy: "",
    managementFee: "",
    netAssetValue: "",
    underlyingAsset: "",
    custodian: "",
    propertyType: "",
    propertyLocation: "",
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

export function isValidDecimals(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 18;
}
