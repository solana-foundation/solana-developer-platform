import { ORGANIZATION_RPC_PROVIDERS, ORGANIZATION_STATUSES, ORGANIZATION_TIERS } from "@sdp/types";
import {
  acceptSchema as acceptSchemaBase,
  inviteSchema as inviteSchemaBase,
} from "../../routes/members/schemas";
import {
  createOrgSchema as createOrgSchemaBase,
  updateOrgSchema as updateOrgSchemaBase,
} from "../../routes/organizations/schemas";
import { z } from "./base";
import {
  apiKeyIdParamSchema,
  apiKeyPrefixSchema,
  invitationIdSchema,
  isoDateTimeSchema,
  memberIdParamSchema,
  orgIdParamSchema,
  userIdSchema,
} from "./base";

export const organizationSettingsSchema = z
  .object({
    rpcProvider: z.enum(ORGANIZATION_RPC_PROVIDERS).optional().openapi({
      description: "Organization-wide preferred RPC provider. `default` uses SDP round-robin.",
      example: "default",
    }),
    defaultEnvironment: z.enum(["sandbox", "production"]).optional().openapi({
      description: "Default environment for new resources.",
      example: "production",
    }),
    webhookSecret: z.string().optional().openapi({
      description: "Webhook signing secret.",
      example: "whsec_example",
    }),
    allowedIpAddresses: z
      .array(z.string())
      .optional()
      .openapi({
        description: "Allowed IP addresses for API access.",
        example: ["203.0.113.0/24"],
      }),
    customRateLimits: z
      .object({
        requestsPerMinute: z.number().int().positive().optional().openapi({
          description: "Maximum requests allowed per minute.",
          example: 60,
        }),
        requestsPerDay: z.number().int().positive().optional().openapi({
          description: "Maximum requests allowed per day.",
          example: 10000,
        }),
      })
      .optional()
      .openapi({ description: "Custom rate limit overrides." }),
  })
  .strict()
  .openapi({ description: "Organization-level settings." });

export const organizationSchema = z
  .object({
    id: orgIdParamSchema,
    name: z.string().openapi({ description: "Organization name.", example: "Example Org" }),
    slug: z.string().openapi({ description: "URL-friendly slug.", example: "example-org" }),
    tier: z
      .enum(ORGANIZATION_TIERS)
      .openapi({ description: "Organization tier.", example: "enterprise" }),
    status: z
      .enum(ORGANIZATION_STATUSES)
      .openapi({ description: "Organization status.", example: "active" }),
    settings: organizationSettingsSchema
      .nullable()
      .openapi({ description: "Organization settings (nullable when unset)." }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Organization record." });

export const userSchema = z
  .object({
    id: userIdSchema,
    email: z.string().email().openapi({ description: "User email.", example: "user@example.com" }),
    name: z.string().nullable().openapi({ description: "User name.", example: "Example User" }),
  })
  .openapi({ description: "User summary." });

export const organizationMemberSchema = z
  .object({
    id: memberIdParamSchema,
    role: z
      .enum(["admin", "member"])
      .openapi({ description: "Organization member role.", example: "member" }),
    status: z
      .enum(["active", "suspended", "removed"])
      .openapi({ description: "Membership status.", example: "active" }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Membership creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    user: userSchema.openapi({ description: "User associated with the membership." }),
  })
  .openapi({ description: "Organization member record." });

export const invitationSchema = z
  .object({
    id: invitationIdSchema,
    email: z
      .string()
      .email()
      .openapi({ description: "Invitee email.", example: "dev@example.com" }),
    role: z
      .enum(["admin", "member"])
      .openapi({ description: "Role offered to the invitee.", example: "member" }),
    expiresAt: isoDateTimeSchema.openapi({
      description: "Invitation expiration timestamp.",
      example: "2025-02-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Invitation summary." });

export const createOrganizationResponseSchema = z
  .object({
    organization: organizationSchema.openapi({ description: "Created organization details." }),
    apiKey: z
      .object({
        id: apiKeyIdParamSchema,
        key: z.string().optional().openapi({
          description: "Full API key. Only returned once.",
          example: "sk_test_example",
        }),
        keyPrefix: apiKeyPrefixSchema,
      })
      .openapi({ description: "Initial API key for the organization." }),
  })
  .openapi({ description: "Create organization response payload." });

export const listMembersResponseSchema = z
  .object({
    members: z.array(organizationMemberSchema).openapi({ description: "Organization members." }),
  })
  .openapi({ description: "List of organization members." });

export const inviteMemberResponseSchema = z
  .object({
    invitation: invitationSchema.openapi({ description: "Invitation details." }),
  })
  .openapi({ description: "Invitation details." });

export const createOrganizationRequestSchema = createOrgSchemaBase
  .extend({
    name: createOrgSchemaBase.shape.name.openapi({
      description: "Organization name.",
      example: "Example Org",
    }),
    slug: createOrgSchemaBase.shape.slug.openapi({
      description: "Optional URL-friendly slug. Generated from name if omitted.",
      example: "example-org",
    }),
    email: createOrgSchemaBase.shape.email.openapi({
      description: "Primary email for allowlist checks.",
      example: "admin@example.com",
    }),
    returnFullApiKey: createOrgSchemaBase.shape.returnFullApiKey?.openapi({
      description: "Whether to return the full API key. Defaults to false.",
      example: false,
    }),
    custody: createOrgSchemaBase.shape.custody?.openapi({
      description:
        "Optional custody configuration to provision a signing wallet for the organization.",
      example: {
        provider: "privy",
      },
    }),
  })
  .openapi({ description: "Create organization request body." });

export const updateOrganizationRequestSchema = updateOrgSchemaBase
  .extend({
    name: updateOrgSchemaBase.shape.name.openapi({
      description: "Updated organization name.",
      example: "Example Org Updated",
    }),
    settings: updateOrgSchemaBase.shape.settings.openapi({
      description: "Organization settings to update.",
      example: {
        rpcProvider: "default",
        defaultEnvironment: "production",
        allowedIpAddresses: ["203.0.113.0/24"],
      },
    }),
  })
  .openapi({ description: "Update organization request body." });

export const inviteMemberRequestSchema = inviteSchemaBase
  .extend({
    email: inviteSchemaBase.shape.email.openapi({
      description: "Invitee email address.",
      example: "dev@example.com",
    }),
    role: inviteSchemaBase.shape.role.openapi({
      description: "Role assigned to the invited member.",
      example: "member",
    }),
  })
  .openapi({ description: "Invite member request body." });

export const acceptInvitationRequestSchema = acceptSchemaBase
  .extend({
    token: acceptSchemaBase.shape.token.openapi({
      description: "Invitation token from email.",
      example: "invitation_token",
    }),
    name: acceptSchemaBase.shape.name.openapi({
      description: "Optional name to set for the user.",
      example: "Example User",
    }),
  })
  .openapi({ description: "Accept invitation request body." });
