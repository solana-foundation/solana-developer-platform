import type {
  AssetCategory,
  AssetProfileStatus,
  IssuanceMetadata,
  PublicTokenMetadata,
} from "@sdp/types";
import type { AppDb } from "@/db";
import type {
  ArchiveAssetProfileInput,
  AssetProfileRow,
  AssetProfilesRepository,
  CreateAssetProfileInput,
  ListAssetProfilesInput,
  ListAssetProfilesResult,
  UpdateAssetProfileInput,
} from "./asset-profile.repository";
import { generateAssetProfileId } from "./asset-profile.repository";

function mapAssetProfileRow(row: Record<string, unknown>): AssetProfileRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    token_id: row.token_id as string,
    asset_category: row.asset_category as AssetCategory,
    asset_type: row.asset_type as string,
    asset_type_version: row.asset_type_version as number,
    issuance_metadata: row.issuance_metadata as IssuanceMetadata,
    public_metadata: row.public_metadata as PublicTokenMetadata,
    status: row.status as AssetProfileStatus,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getAssetProfileByIdInternal(
  db: AppDb,
  params: { profileId: string; organizationId: string; projectId: string }
): Promise<AssetProfileRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM asset_profiles
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?`
    )
    .bind(params.profileId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();
  return row ? mapAssetProfileRow(row) : null;
}

export function createPostgresAssetProfilesRepository(db: AppDb): AssetProfilesRepository {
  return {
    async createAssetProfile(input: CreateAssetProfileInput) {
      const id = generateAssetProfileId();

      await db
        .prepare(
          `INSERT INTO asset_profiles (
             id,
             organization_id,
             project_id,
             token_id,
             asset_category,
             asset_type,
             asset_type_version,
             issuance_metadata,
             public_metadata,
             status,
             created_by
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?,
             COALESCE(?, '{}'::jsonb),
             COALESCE(?, '{}'::jsonb),
             'active', ?
           )`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.tokenId,
          input.assetCategory,
          input.assetType,
          input.assetTypeVersion,
          input.issuanceMetadata,
          input.publicMetadata,
          input.createdBy
        )
        .run();

      return getAssetProfileByIdInternal(db, {
        profileId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateAssetProfile(input: UpdateAssetProfileInput) {
      const rowsAffected = await db
        .prepare(
          `UPDATE asset_profiles
             SET asset_category = COALESCE(?, asset_category),
                 asset_type = COALESCE(?, asset_type),
                 asset_type_version = COALESCE(?, asset_type_version),
                 issuance_metadata = COALESCE(?, issuance_metadata),
                 public_metadata = COALESCE(?, public_metadata),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(
          input.assetCategory ?? null,
          input.assetType ?? null,
          input.assetTypeVersion ?? null,
          input.issuanceMetadata ?? null,
          input.publicMetadata ?? null,
          input.profileId,
          input.organizationId,
          input.projectId
        )
        .run();

      if (rowsAffected === 0) {
        return null;
      }

      return getAssetProfileByIdInternal(db, {
        profileId: input.profileId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async archiveAssetProfile(input: ArchiveAssetProfileInput) {
      const result = await db
        .prepare(
          `UPDATE asset_profiles
             SET status = 'archived',
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(input.profileId, input.organizationId, input.projectId)
        .run();

      if (result === 0) {
        return null;
      }

      return getAssetProfileByIdInternal(db, {
        profileId: input.profileId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async getAssetProfileById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM asset_profiles
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND status = 'active'`
        )
        .bind(params.profileId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapAssetProfileRow(row) : null;
    },

    async getActiveAssetProfileByTokenId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM asset_profiles
             WHERE token_id = ?
               AND organization_id = ?
               AND project_id = ?
               AND status = 'active'`
        )
        .bind(params.tokenId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapAssetProfileRow(row) : null;
    },

    async getPublicMetadataByTokenId(tokenId: string) {
      // token_id is the PK of issued_tokens (globally unique) and the partial
      // unique index guarantees at most one active profile per token, so this
      // returns exactly that token's profile. ORDER BY is a deterministic
      // tiebreak should that invariant ever change.
      const row = await db
        .prepare(
          `SELECT public_metadata
             FROM asset_profiles
            WHERE token_id = ?
              AND status = 'active'
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        )
        .bind(tokenId)
        .first<{ public_metadata: PublicTokenMetadata }>();
      return row ? row.public_metadata : null;
    },

    async listAssetProfiles(params: ListAssetProfilesInput): Promise<ListAssetProfilesResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM asset_profiles
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
                AND (?::text IS NULL OR asset_category = ?)
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.includeArchived ?? false,
            params.category ?? null,
            params.category ?? null,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM asset_profiles
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
                AND (?::text IS NULL OR asset_category = ?)`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.includeArchived ?? false,
            params.category ?? null,
            params.category ?? null
          )
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapAssetProfileRow),
        total: countRow?.total ?? 0,
      };
    },
  };
}
