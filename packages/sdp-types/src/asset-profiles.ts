// Asset Profiles: the SDP-owned description of what an issued token represents.
// See docs/decisions/0001-asset-profile-data-model.md and the Issuance Asset PRD.
//
// Supported categories/types and their validation + public-projection rules are
// defined here in code (the "Asset Type Registry"), NOT in the database. Adding a
// new category or type is a change to this file + the route schemas, never a
// migration. This mirrors how COUNTERPARTY_ACCOUNT_KINDS gates the open-TEXT
// `account_kind` column.

import type { Token } from "./tokens";

// --- Asset Category --------------------------------------------------------

export const ASSET_CATEGORIES = ["generic", "stablecoin", "tokenized_security"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

// --- Asset Type ------------------------------------------------------------

// Canonical list of supported asset types per category, used for validation and
// category<->type consistency. Kept deliberately generic for v1 (the PRD defers
// instrument-specific types such as money market funds, bonds, stocks). The
// ASSET_TYPE_REGISTRY below must define an entry for every pair listed here.
export const ASSET_TYPES = {
  generic: ["generic", "commodity", "real_estate", "collectible"],
  stablecoin: ["fiat_backed", "crypto_backed", "generic"],
  tokenized_security: ["generic", "equity", "debt", "fund"],
} as const satisfies Record<AssetCategory, readonly string[]>;

export type AssetType<C extends AssetCategory = AssetCategory> = (typeof ASSET_TYPES)[C][number];

export function isAssetTypeSupported(category: AssetCategory, type: string): boolean {
  const types: readonly string[] = ASSET_TYPES[category] ?? [];
  return types.includes(type);
}

// --- Asset Type Registry ---------------------------------------------------

export interface AssetTypeRegistryEntry {
  category: AssetCategory;
  type: string;
  // Bumped when the metadata shape / projection / gates for this type change.
  // Stored on the profile row as asset_type_version.
  version: number;
  label: string;
  // Dot-paths into issuance_metadata that are public by default for this type.
  // Used as the projection when a profile has no explicit issuer selection
  // (issuance_metadata.visibility.public); once the issuer customizes it, their
  // selection is projected instead. Either way the application layer clamps to
  // public-safe namespaces (asset.* and chain.decimals), so compliance.* and
  // custom.* can never be exposed.
  publicProjection: readonly string[];
  // Dot-paths required before the token may be deployed (lifecycle gate).
  requiredForDeploy: readonly string[];
}

// One entry per (category, type) pair in ASSET_TYPES.
export const ASSET_TYPE_REGISTRY: readonly AssetTypeRegistryEntry[] = [
  {
    category: "generic",
    type: "generic",
    version: 2,
    label: "Generic asset",
    publicProjection: ["asset.name", "asset.description", "asset.website"],
    requiredForDeploy: [],
  },
  {
    category: "stablecoin",
    type: "fiat_backed",
    version: 2,
    label: "Fiat-backed stablecoin",
    publicProjection: [
      "asset.name",
      "asset.issuerName",
      "asset.pegCurrency",
      "chain.decimals",
      "asset.website",
    ],
    requiredForDeploy: ["asset.issuerName", "asset.pegCurrency"],
  },
  {
    category: "stablecoin",
    type: "generic",
    version: 2,
    label: "Generic stablecoin",
    publicProjection: ["asset.name", "asset.pegCurrency", "chain.decimals", "asset.website"],
    requiredForDeploy: [],
  },
  {
    category: "tokenized_security",
    type: "generic",
    version: 2,
    label: "Generic tokenized security",
    publicProjection: ["asset.name", "asset.issuerName", "asset.website"],
    requiredForDeploy: ["asset.issuerName"],
  },
  {
    category: "stablecoin",
    type: "crypto_backed",
    version: 2,
    label: "Crypto-backed stablecoin",
    publicProjection: ["asset.name", "asset.pegCurrency", "chain.decimals", "asset.website"],
    requiredForDeploy: [],
  },
  {
    category: "tokenized_security",
    type: "equity",
    version: 2,
    label: "Tokenized equity",
    publicProjection: ["asset.name", "asset.issuerName", "asset.website"],
    requiredForDeploy: ["asset.issuerName"],
  },
  {
    category: "tokenized_security",
    type: "debt",
    version: 2,
    label: "Tokenized debt",
    publicProjection: ["asset.name", "asset.issuerName", "asset.website"],
    requiredForDeploy: ["asset.issuerName"],
  },
  {
    category: "tokenized_security",
    type: "fund",
    version: 2,
    label: "Tokenized fund",
    publicProjection: ["asset.name", "asset.issuerName", "asset.website"],
    requiredForDeploy: ["asset.issuerName"],
  },
  {
    category: "generic",
    type: "commodity",
    version: 2,
    label: "Tokenized commodity",
    publicProjection: ["asset.name", "asset.description", "asset.website"],
    requiredForDeploy: [],
  },
  {
    category: "generic",
    type: "real_estate",
    version: 2,
    label: "Tokenized real estate",
    publicProjection: ["asset.name", "asset.description", "asset.website"],
    requiredForDeploy: [],
  },
  {
    category: "generic",
    type: "collectible",
    version: 2,
    label: "Tokenized collectible",
    publicProjection: ["asset.name", "asset.description", "asset.website"],
    requiredForDeploy: [],
  },
];

export function getAssetTypeRegistryEntry(
  category: AssetCategory,
  type: string
): AssetTypeRegistryEntry | undefined {
  return ASSET_TYPE_REGISTRY.find((entry) => entry.category === category && entry.type === type);
}

// --- Metadata model --------------------------------------------------------

// v1 keeps the SDP-owned namespaces generic (the PRD defers instrument-specific
// fields). Shape is enforced at the application layer; custom.* is namespaced so
// customer/integration fields never collide with SDP-defined fields.
export type AssetMetadata = Record<string, unknown>;
export type ComplianceMetadata = Record<string, unknown>;
export type ChainMetadata = Record<string, unknown>;

export interface CustomMetadata {
  customer?: Record<string, unknown>;
  integration?: Record<string, unknown>;
}

// Issuer-controlled public/private field selection. `public` holds the
// issuance_metadata dot-paths the issuer chose to expose (e.g. "asset.issuerName").
// Absent ⇒ the type's registry `publicProjection` is used as the default.
// The application layer clamps these to public-safe namespaces (asset.* and
// chain.decimals) before projecting, so compliance.*/custom.* can never leak,
// and `visibility` itself is never projected into public_metadata.
export interface VisibilityMetadata {
  public?: string[];
}

export interface IssuanceMetadata {
  asset?: AssetMetadata;
  // Private by default — never auto-projected into public metadata.
  compliance?: ComplianceMetadata;
  // SDP-enriched from on-chain reads.
  chain?: ChainMetadata;
  custom?: CustomMetadata;
  // Which fields the issuer publishes. Never itself exposed publicly.
  visibility?: VisibilityMetadata;
  [extension: string]: unknown;
}

// The safe public subset served by the token metadata URI. Derived from
// IssuanceMetadata via the registry's publicProjection rules.
export type PublicTokenMetadata = Record<string, unknown>;

// --- API models ------------------------------------------------------------

export type AssetProfileStatus = "active" | "archived";

export interface AssetProfile {
  id: string;
  organizationId: string;
  projectId: string;
  tokenId: string;
  assetCategory: AssetCategory;
  assetType: string;
  assetTypeVersion: number;
  issuanceMetadata: IssuanceMetadata;
  // Server-computed cache of the public projection; not client-writable.
  publicMetadata: PublicTokenMetadata;
  status: AssetProfileStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssetProfileRequest {
  tokenId: string;
  assetCategory?: AssetCategory;
  assetType?: string;
  issuanceMetadata?: IssuanceMetadata;
}

export interface UpdateAssetProfileRequest {
  assetCategory?: AssetCategory;
  assetType?: string;
  issuanceMetadata?: IssuanceMetadata;
}

export interface AssetProfileResponse {
  assetProfile: AssetProfile;
}

export interface TokenWithAssetProfileResponse {
  token: Token;
  assetProfile: AssetProfile;
}

export interface ListAssetProfilesResponse {
  assetProfiles: AssetProfile[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssetProfileFieldOptions {
  categories: readonly AssetCategory[];
  types: Record<AssetCategory, readonly string[]>;
}

export interface AssetProfileFieldOptionsResponse {
  fields: AssetProfileFieldOptions;
}
