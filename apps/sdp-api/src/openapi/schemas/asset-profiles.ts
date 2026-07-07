import { ASSET_CATEGORIES, ASSET_TYPES } from "@sdp/types";
import {
  assetCategorySchema as assetCategorySchemaBase,
  assetProfileIdSchema as assetProfileIdSchemaBase,
  issuanceMetadataSchema as issuanceMetadataSchemaBase,
  listAssetProfilesQuerySchema as listAssetProfilesQuerySchemaBase,
  updateAssetProfileObjectSchema as updateAssetProfileObjectSchemaBase,
} from "../../routes/asset-profiles/schemas";
import {
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  userIdSchema,
  withOpenApi,
  z,
} from "./base";

export const assetProfileIdParamSchema = withOpenApi(assetProfileIdSchemaBase, {
  description: "Asset profile identifier.",
  example: "asset_profile_example",
});

export const assetCategorySchema = withOpenApi(assetCategorySchemaBase, {
  description: "Broad product/regulatory grouping for an issued asset.",
  example: "stablecoin",
});

const issuanceMetadataExample = {
  asset: {
    name: "Acme USD",
    issuerName: "Acme Financial Inc.",
    pegCurrency: "USD",
    website: "https://acme.example",
  },
  compliance: { transferRestrictions: "reg_d" },
  chain: { decimals: 6 },
  custom: { customer: { internalDeskId: "FX-22" }, integration: {} },
  visibility: { public: ["asset.name", "asset.issuerName", "asset.pegCurrency", "chain.decimals"] },
};

export const issuanceMetadataSchema = withOpenApi(issuanceMetadataSchemaBase, {
  description:
    "Canonical, private master metadata for the asset. SDP-owned namespaces (asset, compliance, chain) plus a namespaced custom bucket (customer, integration). " +
    "The optional `visibility.public` array holds the issuance_metadata dot-paths the issuer chose to expose publicly; when omitted, the asset type's registry default is used. " +
    "Only asset.* and chain.decimals paths can ever be projected publicly — compliance and custom fields are private by default and can never be exposed, even if listed in visibility.public.",
  example: issuanceMetadataExample,
});

export const publicTokenMetadataSchema = z.record(z.string(), z.unknown()).openapi({
  description:
    "Safe public subset of the issuance metadata, derived via the asset type's projection rules. Served by the public token metadata URI.",
  example: {
    asset: { name: "Acme USD", issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
    chain: { decimals: 6 },
  },
});

export const assetProfileSchema = withOpenApi(
  z.object({
    id: assetProfileIdParamSchema,
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    tokenId: withOpenApi(z.string(), {
      description: "Identifier of the issued token this profile describes.",
      example: "tok_example",
    }),
    assetCategory: assetCategorySchema,
    assetType: withOpenApi(z.string(), {
      description: "Concrete asset type within the category.",
      example: "fiat_backed",
    }),
    assetTypeVersion: withOpenApi(z.number().int().positive(), {
      description:
        "Version of the asset type registry contract this profile was validated against.",
      example: 2,
    }),
    issuanceMetadata: issuanceMetadataSchema,
    publicMetadata: publicTokenMetadataSchema,
    status: withOpenApi(z.enum(["active", "archived"]), {
      description: "Asset profile status.",
      example: "active",
    }),
    createdBy: withOpenApi(userIdSchema.nullable(), {
      description: "User who created the profile. Null when created via API key.",
    }),
    createdAt: withOpenApi(isoDateTimeSchema, {
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: withOpenApi(isoDateTimeSchema, {
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  }),
  { description: "Asset profile record: SDP-owned description of what an issued token represents." }
);

export const assetProfileResponseSchema = withOpenApi(
  z.object({ assetProfile: assetProfileSchema }),
  { description: "Asset profile response payload." }
);

export const listAssetProfilesResponseSchema = withOpenApi(
  z.object({
    assetProfiles: withOpenApi(z.array(assetProfileSchema), { description: "Asset profiles." }),
    total: withOpenApi(z.number().int().nonnegative(), {
      description: "Total asset profiles matching the query.",
      example: 7,
    }),
    page: withOpenApi(z.number().int().positive(), {
      description: "Current page number.",
      example: 1,
    }),
    pageSize: withOpenApi(z.number().int().positive(), {
      description: "Items per page.",
      example: 20,
    }),
  }),
  { description: "Paginated list of asset profiles." }
);

export const assetProfileFieldOptionsResponseSchema = withOpenApi(
  z.object({
    fields: z.object({
      categories: z.array(z.enum(ASSET_CATEGORIES)),
      types: z.object({
        generic: z.array(z.enum(ASSET_TYPES.generic)),
        stablecoin: z.array(z.enum(ASSET_TYPES.stablecoin)),
        tokenized_security: z.array(z.enum(ASSET_TYPES.tokenized_security)),
      }),
    }),
  }),
  {
    description:
      "Field option sets for building an asset profile form: supported categories and the asset types available within each.",
  }
);

export const listAssetProfilesQuerySchema = listAssetProfilesQuerySchemaBase.extend({
  page: withOpenApi(listAssetProfilesQuerySchemaBase.shape.page, {
    description: "Page number (1-based).",
    example: 1,
  }),
  pageSize: withOpenApi(listAssetProfilesQuerySchemaBase.shape.pageSize, {
    description: "Items per page (max 100).",
    example: 20,
  }),
  includeArchived: withOpenApi(listAssetProfilesQuerySchemaBase.shape.includeArchived, {
    description: "Include archived asset profiles in results.",
    example: false,
  }),
  category: withOpenApi(listAssetProfilesQuerySchemaBase.shape.category, {
    description: "Filter by asset category.",
    example: "stablecoin",
  }),
});

export const updateAssetProfileRequestSchema = withOpenApi(
  updateAssetProfileObjectSchemaBase.extend({
    assetCategory: withOpenApi(updateAssetProfileObjectSchemaBase.shape.assetCategory, {
      description: "Updated asset category. Must remain consistent with the asset type.",
      example: "stablecoin",
    }),
    assetType: withOpenApi(updateAssetProfileObjectSchemaBase.shape.assetType, {
      description: "Updated asset type. Must be supported for the (resulting) category.",
      example: "fiat_backed",
    }),
    issuanceMetadata: withOpenApi(issuanceMetadataSchema.optional(), {
      description:
        "Updated issuance metadata. Replaces the existing object; public metadata is recomputed.",
      example: issuanceMetadataExample,
    }),
  }),
  {
    description: "Update asset profile request body. At least one field must be provided.",
    minProperties: 1,
  }
);
