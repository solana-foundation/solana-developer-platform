import { ASSET_CATEGORIES, isAssetTypeSupported } from "@sdp/types";
import { z } from "zod";

// Free-form JSON object (a namespace bucket inside issuance metadata). Mirrors
// the JSONB columns' `jsonb_typeof(...) = 'object'` DB constraint.
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const assetCategorySchema = z.enum(ASSET_CATEGORIES);

// Asset type is validated against the registry (per category) in the create /
// update refinements below, so the field itself only checks basic shape here.
export const assetTypeSchema = z.string().min(1).max(128);

export const assetProfileIdSchema = z.string().min(1);

export const assetProfileIdParamsSchema = z.object({
  profileId: assetProfileIdSchema,
});

export const assetProfileTokenIdParamsSchema = z.object({
  tokenId: z.string().min(1),
});

// custom.* is namespaced so customer and integration fields can never collide
// with SDP-defined fields. Each namespace is an open object.
const customMetadataSchema = z.object({
  customer: jsonObjectSchema.optional(),
  integration: jsonObjectSchema.optional(),
});

// Issuer-controlled public/private field selection. `public` lists the
// issuance_metadata dot-paths (e.g. "asset.issuerName") the issuer chose to
// expose. Absent ⇒ the asset type's registry default is used. The application
// layer clamps these to public-safe namespaces (asset.* and chain.decimals)
// before projecting, so compliance.* and custom.* can never be exposed.
const visibilityMetadataSchema = z.object({
  public: z.array(z.string()).optional(),
});

// Strict on the SDP-owned namespaces, but loose *within* them for v1 (the PRD
// defers instrument-specific field modelling). `z.looseObject` allows unknown
// top-level namespaces to pass through without a schema change.
export const issuanceMetadataSchema = z.looseObject({
  asset: jsonObjectSchema.optional(),
  compliance: jsonObjectSchema.optional(),
  chain: jsonObjectSchema.optional(),
  custom: customMetadataSchema.optional(),
  visibility: visibilityMetadataSchema.optional(),
});

export function assertAssetTypeSupported(
  value: { assetCategory?: string; assetType?: string },
  ctx: z.RefinementCtx
): void {
  // Defaults are applied before refinement runs, so both are present here.
  const category = value.assetCategory as (typeof ASSET_CATEGORIES)[number];
  const type = value.assetType ?? "";
  if (!isAssetTypeSupported(category, type)) {
    ctx.addIssue({
      code: "custom",
      path: ["assetType"],
      message: `Unsupported assetType "${type}" for category "${category}"`,
    });
  }
}

export const updateAssetProfileObjectSchema = z.object({
  assetCategory: assetCategorySchema.optional(),
  assetType: assetTypeSchema.optional(),
  issuanceMetadata: issuanceMetadataSchema.optional(),
});

export const updateAssetProfileSchema = updateAssetProfileObjectSchema
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  })
  .superRefine((value, ctx) => {
    // Only validate the pair when BOTH halves are present in the patch. If just
    // one changes, it must be checked against the existing row's other half,
    // which only the handler can do after loading the current profile.
    // NOTE: the update handler MUST re-run isAssetTypeSupported() on the merged
    // (existing + patch) category/type before persisting.
    if (value.assetCategory === undefined || value.assetType === undefined) {
      return;
    }
    assertAssetTypeSupported(value, ctx);
  });

export const listAssetProfilesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z.coerce.boolean().default(false),
  category: assetCategorySchema.optional(),
});
