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

// Schemes that execute or inline content when a consumer renders them. These
// are refused wherever they appear in the namespace, not only under a key whose
// NAME looked like a link — `banner`, `avatar` and anything nested are rendered
// the same way.
const ACTIVE_CONTENT_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "blob:", "file:"]);

// The leading scheme of a string, if it opens with one. Judged on the prefix
// rather than on the whole string being URI-shaped: a browser handed
// `javascript:alert(1) // note` as an href runs it, so a body containing
// whitespace is not evidence that the value is prose. Text that merely quotes a
// scheme mid-sentence never starts with one and stays unconstrained.
const LEADING_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

const parseUri = (value: string): URL | null => {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
};

const isHttpUrl = (value: string): boolean => {
  const url = parseUri(value);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
};

const isActiveContentUri = (value: string): boolean => {
  const scheme = LEADING_SCHEME_PATTERN.exec(value.trim())?.[0];
  return scheme !== undefined && ACTIVE_CONTENT_SCHEMES.has(scheme.toLowerCase());
};

function collectActiveContentIssues(
  value: unknown,
  path: Array<string | number>,
  issues: Array<{ path: Array<string | number>; message: string }>
): void {
  if (typeof value === "string") {
    if (isActiveContentUri(value)) {
      issues.push({
        path,
        message: `asset.${path.join(".")} must not be an active-content URI`,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectActiveContentIssues(entry, [...path, index], issues);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectActiveContentIssues(entry, [...path, key], issues);
    }
  }
}

// The namespace stays open. A key that names a link must hold a bounded http(s)
// URL, as before; everywhere else only active-content URIs are refused, so
// `urn:`/`mailto:` values and free text keep working.
const assetMetadataSchema = jsonObjectSchema.superRefine((record, ctx) => {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];

  for (const [key, value] of Object.entries(record)) {
    if (value == null) {
      continue;
    }
    if (LINK_KEY_PATTERN.test(key)) {
      if (typeof value !== "string" || value.length > MAX_LINK_LENGTH || !isHttpUrl(value)) {
        issues.push({
          path: [key],
          message: `asset.${key} must be an http(s) URL of at most ${MAX_LINK_LENGTH} characters`,
        });
      }
      continue;
    }
    collectActiveContentIssues(value, [key], issues);
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
