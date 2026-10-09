import {
  type ProjectProviderAvailabilityEntry,
  projectProviderAvailabilityEntrySchema,
  projectProviderAvailabilitySchema,
} from "@sdp/types";
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

const PROJECT_PROVIDER_AVAILABILITY_EXAMPLE_PROVIDERS = [
  {
    family: "custody",
    provider: "privy",
    modes: ["byok"],
    unavailableModes: [{ mode: "managed", reason: "custody_mode_not_allowed" }],
  },
  {
    family: "custody",
    provider: "fireblocks",
    modes: [],
    unavailableModes: [
      { mode: "managed", reason: "custody_mode_not_allowed" },
      { mode: "byok", reason: "custody_provider_not_in_release_channel" },
    ],
  },
  { family: "compliance", provider: "range", available: true },
  { family: "ramps", provider: "moonpay", available: false, reason: "provider_not_entitled" },
] as const satisfies readonly ProjectProviderAvailabilityEntry[];

/**
 * The documented project provider availability, with or without the Earn
 * family. While `EARN_PUBLIC_SURFACE_PUBLISHED` is false the public document
 * leaves Earn out and the runtime response omits Earn entries to match it.
 *
 * @param publishEarn - Whether the document carries the Earn family.
 * @returns The response schema, its description and example matching `publishEarn`.
 */
export function projectProviderAvailabilityResponseSchema(publishEarn: boolean) {
  const [custodyEntry, complianceEntry, rampsEntry] =
    projectProviderAvailabilityEntrySchema.options;
  const schema = publishEarn
    ? projectProviderAvailabilitySchema
    : projectProviderAvailabilitySchema.extend({
        providers: z.array(
          z.discriminatedUnion("family", [custodyEntry, complianceEntry, rampsEntry])
        ),
      });
  const nonCustodyFamilies = publishEarn ? "ramps, compliance and Earn" : "ramps and compliance";
  return withOpenApi(schema, {
    description: `Every provider the deployment knows, with whether this project can use it, so an absent provider is never mistaken for an unavailable one. Custody entries list the custody modes the project can set the provider up in (empty when none) in \`modes\`, and each refused mode with the first failed check in \`unavailableModes\`; ${nonCustodyFamilies} entries carry \`available\`, plus \`reason\` naming the first failed check when unavailable. A provider is available only when the deployment's release channel includes it, SDP currently offers it, the organization is entitled to it, and the deployment holds its credentials for the project's environment; the release channel offers the same providers to Sandbox and Production projects. Custody \`modes\` include \`managed\` only in a Sandbox project whose deployment holds the provider's credentials; \`byok\` runs on the organization's own credentials and is the only mode a Production project can use.`,
    example: {
      projectId: "prj_example",
      environment: "production",
      providers: publishEarn
        ? [
            ...PROJECT_PROVIDER_AVAILABILITY_EXAMPLE_PROVIDERS,
            {
              family: "earn",
              provider: "kamino",
              available: false,
              reason: "provider_not_entitled",
            },
          ]
        : PROJECT_PROVIDER_AVAILABILITY_EXAMPLE_PROVIDERS,
    },
  });
}

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
