import { ASSET_CATEGORIES, isAssetTypeSupported } from "@sdp/types";
import { z } from "zod";
import { queryBooleanSchema } from "@/openapi/schemas/base";

// Free-form JSON object; mirrors JSONB `= 'object'` DB constraint.
const jsonObjectSchema = z.record(z.string(), z.unknown());

// Link-bearing keys in the open `asset` namespace. `asset.website` sits on the
// default public projection of most registry types and is served verbatim by
// the public metadata.json, so a javascript:/data: value stored here becomes an
// active-content link on every consumer that renders it (HOO-1013).
const LINK_KEY_PATTERN = /^(?:website|homepage)$|(?:url|uri|link|logo|image|icon)$/i;

const MAX_LINK_LENGTH = 2048;

// A whole string that is a scheme plus a body, with no whitespace anywhere:
// `javascript:alert(1)` is a URI, `javascript:alert(1), quoted in a report` is
// prose. Free text in the open namespace stays free text.
const URI_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\S+$/i;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

// The namespace stays open, but nothing in it may carry a non-http(s) URI into
// public metadata. Keying this on the KEY name missed `banner`, `avatar` and
// anything nested; the value is what ends up rendered, so the value decides.
function collectLinkIssues(
  value: unknown,
  path: Array<string | number>,
  issues: Array<{ path: Array<string | number>; message: string }>
): void {
  if (typeof value === "string") {
    if (!URI_LIKE_PATTERN.test(value)) {
      return;
    }
    if (value.length > MAX_LINK_LENGTH || !isHttpUrl(value)) {
      issues.push({
        path,
        message: `asset.${path.join(".")} must be an http(s) URL of at most ${MAX_LINK_LENGTH} characters`,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLinkIssues(entry, [...path, index], issues));
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectLinkIssues(entry, [...path, key], issues);
    }
  }
}

const assetMetadataSchema = jsonObjectSchema.superRefine((record, ctx) => {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];

  for (const [key, value] of Object.entries(record)) {
    if (value == null) {
      continue;
    }
    // A key that names a link must hold a string: `website: {}` is not a link
    // the value walk can judge, and must not pass by being the wrong type.
    if (LINK_KEY_PATTERN.test(key) && typeof value !== "string") {
      issues.push({
        path: [key],
        message: `asset.${key} must be an http(s) URL of at most ${MAX_LINK_LENGTH} characters`,
      });
      continue;
    }
    collectLinkIssues(value, [key], issues);
  }

  for (const issue of issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});

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
  asset: assetMetadataSchema.optional(),
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
  // Comma-separated token ids, so a caller rendering one page of the asset list
  // can hydrate exactly those tokens' profiles in a single request. Capped at
  // the max page size, deduped, and blank entries dropped.
  tokenIds: z
    .string()
    .transform((value) =>
      Array.from(
        new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        )
      )
    )
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(100))
    .optional(),
});
