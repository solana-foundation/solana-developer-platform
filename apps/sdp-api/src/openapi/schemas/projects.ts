import {
  addMemberSchema as addMemberSchemaBase,
  createProjectSchema as createProjectSchemaBase,
  updateMemberSchema as updateMemberSchemaBase,
  updateProjectSchema as updateProjectSchemaBase,
} from "../../routes/projects/schemas";
import { apiKeyListItemSchema } from "./api-keys";
import { z } from "./base";
import {
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  projectMemberIdSchema,
  userIdSchema,
} from "./base";
import { userSchema } from "./organizations";

export const projectSettingsSchema = z
  .object({
    rpcEndpoint: z.string().url().optional().openapi({
      description: "Custom Solana RPC endpoint for the project.",
      example: "https://api.devnet.solana.com",
    }),
    webhookUrl: z.string().url().optional().openapi({
      description: "Webhook URL for event notifications.",
      example: "https://example.com/webhook",
    }),
    metadata: z
      .record(z.string())
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
    settings: projectSettingsSchema
      .nullable()
      .openapi({ description: "Project settings (nullable when unset)." }),
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

export const createProjectRequestSchema = createProjectSchemaBase
  .extend({
    name: createProjectSchemaBase.shape.name.openapi({
      description: "Project name.",
      example: "Payments",
    }),
    slug: createProjectSchemaBase.shape.slug.openapi({
      description: "Optional URL-friendly slug.",
      example: "payments",
    }),
    description: createProjectSchemaBase.shape.description.openapi({
      description: "Optional project description.",
      example: "Project for payments workflows.",
    }),
    environment: createProjectSchemaBase.shape.environment.openapi({
      description: "Project environment.",
      example: "sandbox",
    }),
    settings: createProjectSchemaBase.shape.settings.openapi({
      description: "Optional project settings.",
      example: {
        rpcEndpoint: "https://api.devnet.solana.com",
        webhookUrl: "https://example.com/webhook",
        metadata: { region: "us" },
      },
    }),
  })
  .openapi({ description: "Create project request body." });

export const updateProjectRequestSchema = updateProjectSchemaBase
  .extend({
    name: updateProjectSchemaBase.shape.name.openapi({
      description: "Updated project name.",
      example: "Payments Updated",
    }),
    description: updateProjectSchemaBase.shape.description.openapi({
      description: "Updated description. Use null to clear.",
      example: "Updated project description.",
    }),
    environment: updateProjectSchemaBase.shape.environment.openapi({
      description: "Updated project environment.",
      example: "production",
    }),
    settings: updateProjectSchemaBase.shape.settings.openapi({
      description: "Updated project settings. Use null to clear.",
      example: {
        rpcEndpoint: "https://api.mainnet-beta.solana.com",
      },
    }),
  })
  .openapi({ description: "Update project request body." });

export const addProjectMemberRequestSchema = addMemberSchemaBase
  .extend({
    userId: addMemberSchemaBase.shape.userId.openapi({
      description: "User identifier to add to the project.",
      example: "usr_example",
    }),
    role: addMemberSchemaBase.shape.role.openapi({
      description: "Role for the project member.",
      example: "developer",
    }),
  })
  .openapi({ description: "Add project member request body." });

export const updateProjectMemberRequestSchema = updateMemberSchemaBase
  .extend({
    role: updateMemberSchemaBase.shape.role.openapi({
      description: "Updated project member role.",
      example: "admin",
    }),
  })
  .openapi({ description: "Update project member request body." });
