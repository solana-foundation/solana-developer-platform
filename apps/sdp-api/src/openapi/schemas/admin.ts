import { addEntrySchema as addEntrySchemaBase } from "../../routes/allowlist/schemas";
import { allowlistEntryIdParamSchema, isoDateTimeSchema, withOpenApi, z } from "./base";

export const allowlistEntrySchema = z
  .object({
    id: allowlistEntryIdParamSchema,
    type: z
      .enum(["email", "domain"])
      .openapi({ description: "Allowlist entry type.", example: "domain" }),
    value: z
      .string()
      .openapi({ description: "Email address or domain value.", example: "example.com" }),
    tier: z.string().openapi({ description: "Allowlist tier label.", example: "standard" }),
    notes: z
      .string()
      .nullable()
      .openapi({ description: "Optional notes.", example: "Approved partner" }),
    status: z
      .enum(["active", "disabled"])
      .openapi({ description: "Allowlist entry status.", example: "active" }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Allowlist entry record." });

export const allowlistEntriesResponseSchema = z
  .object({
    entries: z.array(allowlistEntrySchema).openapi({ description: "Allowlist entries." }),
  })
  .openapi({ description: "Allowlist entries response payload." });

export const addAdminAllowlistEntryRequestSchema = addEntrySchemaBase
  .extend({
    type: withOpenApi(addEntrySchemaBase.shape.type, {
      description: "Allowlist entry type.",
      example: "email",
    }),
    value: withOpenApi(addEntrySchemaBase.shape.value, {
      description: "Email or domain to allowlist.",
      example: "example.com",
    }),
    tier: withOpenApi(addEntrySchemaBase.shape.tier, {
      description: "Optional allowlist tier.",
      example: "standard",
    }),
    notes: withOpenApi(addEntrySchemaBase.shape.notes, {
      description: "Optional notes.",
      example: "Approved partner",
    }),
  })
  .openapi({ description: "Add allowlist entry request body." });
