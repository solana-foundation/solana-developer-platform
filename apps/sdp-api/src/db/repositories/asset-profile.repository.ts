import type {
  AssetCategory,
  AssetProfileStatus,
  IssuanceMetadata,
  PublicTokenMetadata,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateAssetProfileId(): string {
  return `asset_profile_${crypto.randomUUID()}`;
}

export interface AssetProfileRow {
  id: string;
  organization_id: string;
  project_id: string;
  token_id: string;
  asset_category: AssetCategory;
  asset_type: string;
  asset_type_version: number;
  issuance_metadata: IssuanceMetadata;
  public_metadata: PublicTokenMetadata;
  status: AssetProfileStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAssetProfileInput {
  organizationId: string;
  projectId: string;
  tokenId: string;
  assetCategory: AssetCategory;
  assetType: string;
  assetTypeVersion: number;
  issuanceMetadata: IssuanceMetadata;
  publicMetadata: PublicTokenMetadata;
  createdBy: string | null;
}

export interface UpdateAssetProfileInput {
  profileId: string;
  organizationId: string;
  projectId: string;
  assetCategory?: AssetCategory;
  assetType?: string;
  assetTypeVersion?: number;
  issuanceMetadata?: IssuanceMetadata;
  // Recomputed by the handler whenever issuanceMetadata or the type changes.
  publicMetadata?: PublicTokenMetadata;
}

export interface ArchiveAssetProfileInput {
  profileId: string;
  organizationId: string;
  projectId: string;
}

export interface ListAssetProfilesInput {
  organizationId: string;
  projectId: string;
  category?: AssetCategory;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

export interface ListAssetProfilesResult {
  rows: AssetProfileRow[];
  total: number;
}

export interface AssetProfilesRepositoryContext {
  db: RepositoryDbClient;
}

export interface AssetProfilesRepository {
  createAssetProfile(input: CreateAssetProfileInput): Promise<AssetProfileRow | null>;
  updateAssetProfile(input: UpdateAssetProfileInput): Promise<AssetProfileRow | null>;
  archiveAssetProfile(input: ArchiveAssetProfileInput): Promise<AssetProfileRow | null>;
  getAssetProfileById(params: {
    profileId: string;
    organizationId: string;
    projectId: string;
  }): Promise<AssetProfileRow | null>;
  getActiveAssetProfileByTokenId(params: {
    tokenId: string;
    organizationId: string;
    projectId: string;
  }): Promise<AssetProfileRow | null>;
  // Used by the public, unauthenticated canonical token metadata URI
  // (/v1/issuance/tokens/:tokenId/metadata.json). Keyed by tokenId alone:
  // token_id is the PK of issued_tokens (globally unique). Returns the cached public_metadata.
  getPublicMetadataByTokenId(tokenId: string): Promise<PublicTokenMetadata | null>;
  listAssetProfiles(params: ListAssetProfilesInput): Promise<ListAssetProfilesResult>;
}
