import { projectProviderAvailabilitySchema } from "@sdp/types";
import {
  addMemberSchema as addMemberSchemaBase,
  updateMemberSchema as updateMemberSchemaBase,
  updateProjectSchema as updateProjectSchemaBase,
} from "../../routes/projects/schemas";
import { apiKeyListItemSchema } from "./api-keys";
import {
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  projectMemberIdSchema,
  userIdSchema,
  withOpenApi,
  z,
} from "./base";
import { userSchema } from "./organizations";

export const projectSettingsSchema = z
  .object({
    webhookUrl: z.string().url().optional().openapi({
      description: "Webhook URL for event notifications.",
      example: "https://example.com/webhook",
    }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description: "Arbitrary metadata key/value pairs.",
        example: { region: "us" },
      }),
  })
  .strict()
  .openapi({ description: "Project settings." });

export const projectSchema = z
  .object({
    id: projectIdParamSchema,
    organizationId: orgIdParamSchema,
    name: z.string().openapi({ description: "Project name.", example: "Payments" }),
    slug: z.string().openapi({ description: "URL-friendly slug.", example: "payments" }),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Optional project description.", example: "Payments workflow" }),
    environment: z
      .enum(["sandbox", "beta", "production"])
      .openapi({ description: "Project environment.", example: "sandbox" }),
    settings: projectSettingsSchema.nullable().openapi({
      description: "Project settings, or null when none have been set.",
    }),
    status: z.enum(["active", "archived"]).openapi({
      description: "Project status.",
      example: "active",
    }),
    createdBy: userIdSchema.openapi({
      description: "Identifier of the creator.",
      example: "usr_example",
    }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Project record." });

export const projectMemberSchema = z
  .object({
    id: projectMemberIdSchema,
    projectId: projectIdParamSchema,
    userId: userIdSchema,
    role: z
      .enum(["admin", "developer", "viewer"])
      .openapi({ description: "Project member role.", example: "developer" }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Membership creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Project member record." });

export const projectMemberWithUserSchema = z
  .object({
    id: projectMemberIdSchema,
    projectId: projectIdParamSchema,
    userId: userIdSchema,
    role: z
      .enum(["admin", "developer", "viewer"])
      .openapi({ description: "Project member role.", example: "developer" }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Membership creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    user: userSchema.openapi({ description: "User details for the project member." }),
  })
  .openapi({ description: "Project member record with user details." });

export const projectResponseSchema = z
  .object({
    project: projectSchema.openapi({ description: "Project details." }),
  })
  .openapi({ description: "Project response payload." });

export const listProjectsResponseSchema = z
  .object({
    projects: z.array(projectSchema).openapi({ description: "Projects." }),
  })
  .openapi({ description: "List of projects." });

export const projectMemberResponseSchema = z
  .object({
    member: projectMemberWithUserSchema.openapi({ description: "Project member details." }),
  })
  .openapi({ description: "Project member response payload." });

export const listProjectMembersResponseSchema = z
  .object({
    members: z.array(projectMemberWithUserSchema).openapi({ description: "Project members." }),
  })
  .openapi({ description: "List of project members." });

export const listProjectApiKeysResponseSchema = z
  .object({
    apiKeys: z.array(apiKeyListItemSchema).openapi({ description: "Project API keys." }),
  })
  .openapi({ description: "List of project API keys." });

export const projectProviderAvailabilityResponseSchema = withOpenApi(
  projectProviderAvailabilitySchema,
  {
    description:
      "Every provider the deployment knows, with whether this project can use it, so an absent provider is never mistaken for an unavailable one. Custody entries list the custody modes the project can set the provider up in (empty when none); ramps, compliance and Earn entries carry `available`. A provider is available only when the deployment's release channel includes it, the organization is entitled to it, in a Production project its stage is stable, and the deployment holds its credentials for the project's environment. Custody `modes` include `managed` only when the deployment holds the provider's credentials; `byok` runs on the organization's own credentials.",
    example: {
      projectId: "proj_example",
      environment: "production",
      providers: [
        { family: "custody", provider: "privy", modes: ["byok"] },
        { family: "custody", provider: "fireblocks", modes: [] },
        { family: "compliance", provider: "range", available: true },
        { family: "ramps", provider: "moonpay", available: false },
        { family: "earn", provider: "kamino", available: false },
      ],
    },
  }
);

export const updateProjectRequestSchema = updateProjectSchemaBase
  .extend({
    name: withOpenApi(updateProjectSchemaBase.shape.name, {
      description: "Updated project name.",
      example: "Payments Updated",
    }),
    description: withOpenApi(updateProjectSchemaBase.shape.description, {
      description: "Updated description. Use null to clear.",
      example: "Updated project description.",
    }),
    settings: withOpenApi(updateProjectSchemaBase.shape.settings, {
      description: "Updated project settings. Use null to clear.",
      example: {
        webhookUrl: "https://example.com/webhook",
      },
    }),
  })
  .openapi({ description: "Update project request body." });

export const addProjectMemberRequestSchema = addMemberSchemaBase
  .extend({
    userId: withOpenApi(addMemberSchemaBase.shape.userId, {
      description: "User identifier to add to the project.",
      example: "usr_example",
    }),
    role: withOpenApi(addMemberSchemaBase.shape.role, {
      description: "Role for the project member.",
      example: "developer",
    }),
  })
  .openapi({ description: "Add project member request body." });

export const updateProjectMemberRequestSchema = updateMemberSchemaBase
  .extend({
    role: withOpenApi(updateMemberSchemaBase.shape.role, {
      description: "Updated project member role.",
      example: "admin",
    }),
  })
  .openapi({ description: "Update project member request body." });
