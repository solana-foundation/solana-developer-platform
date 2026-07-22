import { ASSET_CATEGORIES, isAssetTypeSupported } from "@sdp/types";
import { z } from "zod";
import { queryBooleanSchema } from "@/openapi/schemas/base";

// Free-form JSON object; mirrors JSONB `= 'object'` DB constraint.
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const assetCategorySchema = z.enum(ASSET_CATEGORIES);

// Registry validation in create/update refinements; shape only here.
export const assetTypeSchema = z.string().min(1).max(128);

export const assetProfileIdSchema = z.string().min(1);

export const assetProfileIdParamsSchema = z.object({
  profileId: assetProfileIdSchema,
});

export const assetProfileTokenIdParamsSchema = z.object({
  tokenId: z.string().min(1),
});

// Namespaced to prevent collisions with SDP fields; each namespace open.
const customMetadataSchema = z.object({
  customer: jsonObjectSchema.optional(),
  integration: jsonObjectSchema.optional(),
});

// Issuer-controlled field list; app layer clamps to public-safe namespaces (asset.*, chain.decimals).
const visibilityMetadataSchema = z.object({
  public: z.array(z.string()).optional(),
});

// Validates shape only; catalog bounds (allowance, param ranges) checked in handlers.
// Version is server-stamped, optional on input.
const settingSelectionSchema = z
  .object({
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const advancedSettingsSchema = z
  .object({
    version: z.number().int().positive().optional(),
    selected: z.record(z.string(), settingSelectionSchema),
  })
  .strict();

// Strict namespaces, loose within for v1; looseObject allows future top-level fields.
export const issuanceMetadataSchema = z.looseObject({
  asset: jsonObjectSchema.optional(),
  compliance: jsonObjectSchema.optional(),
  chain: jsonObjectSchema.optional(),
  custom: customMetadataSchema.optional(),
  visibility: visibilityMetadataSchema.optional(),
  settings: advancedSettingsSchema.optional(),
});

export function assertAssetTypeSupported(
  value: { assetCategory?: string; assetType?: string },
  ctx: z.RefinementCtx
): void {
  // Defaults applied before refinement; both present here.
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
    // Only validate pair when both present; handler checks merged state vs current row.
    if (value.assetCategory === undefined || value.assetType === undefined) {
      return;
    }
    assertAssetTypeSupported(value, ctx);
  });

export const listAssetProfilesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: queryBooleanSchema.default(false),
  category: assetCategorySchema.optional(),
});
