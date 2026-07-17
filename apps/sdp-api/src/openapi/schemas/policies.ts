import { policyControlInventoryQuerySchema as policyControlInventoryQuerySchemaBase } from "../../routes/policies/schemas";
import { isoDateTimeSchema, withOpenApi, z } from "./base";

const policyControlInventoryStatusSchema = z.enum(["default_allow", "draft", "active", "disabled"]);

const policyDefaultActionSchema = z.enum(["allow", "deny", "approval_required", "review"]);

const policyDecisionSchema = z.enum([
  "allow",
  "deny",
  "approval_required",
  "provider_approval_required",
  "review",
  "not_evaluated",
]);

const latestEvaluationSchema = z
  .object({
    decision: policyDecisionSchema.openapi({ description: "Latest policy evaluation decision." }),
    evaluatedAt: isoDateTimeSchema.openapi({
      description: "Timestamp of the latest policy evaluation.",
    }),
  })
  .nullable()
  .openapi({ description: "Latest redacted policy evaluation summary, when available." });

const inventoryItemBaseShape = {
  targetId: z.string().openapi({ description: "Stable control-target identifier." }),
  displayName: z.string().openapi({ description: "Wallet display name or API-key label." }),
  controlProfileId: z.string().nullable().openapi({
    description: "Selected target-bound control profile ID, or null for implicit default allow.",
  }),
  status: policyControlInventoryStatusSchema.openapi({
    description: "Computed inventory status. Disabled profiles remain disabled, not default allow.",
  }),
  activeRevisionId: z.string().nullable().openapi({
    description: "Active immutable revision ID, when the selected profile has one.",
  }),
  activeRevisionNumber: z.number().int().positive().nullable().openapi({
    description: "Active immutable revision number, when available.",
  }),
  defaultAction: policyDefaultActionSchema.openapi({
    description: "Default action from the active or latest draft revision.",
  }),
  ruleCount: z.number().int().nonnegative().openapi({
    description: "Rule count from the active or latest draft revision.",
  }),
  updatedAt: isoDateTimeSchema.openapi({ description: "Last target-control update timestamp." }),
  activatedAt: isoDateTimeSchema.nullable().openapi({
    description: "Profile activation timestamp, when active or previously activated.",
  }),
  latestEvaluation: latestEvaluationSchema,
};

const walletPolicyControlInventoryItemSchema = z
  .object({
    ...inventoryItemBaseShape,
    targetType: z.literal("wallet"),
    walletId: z.string().openapi({ description: "Provider-facing wallet ID." }),
    walletAddress: z.string().openapi({ description: "Wallet public address." }),
    providerMappingStatus: z
      .enum(["not_applicable", "pending", "synced", "partial", "failed"])
      .openapi({ description: "Mapping status for the wallet's custody provider." }),
  })
  .openapi({ description: "Wallet policy-control inventory row." });

const apiKeyPolicyControlInventoryItemSchema = z
  .object({
    ...inventoryItemBaseShape,
    targetType: z.literal("api_key"),
    apiKeyPrefix: z.string().openapi({
      description: "Redacted API-key prefix. Secret key material is never returned.",
    }),
    bindingScope: z.enum(["all", "selected"]).nullable().openapi({
      description: "Whether policy bindings apply to all or selected wallets, when configured.",
    }),
    selectedWalletCount: z.number().int().nonnegative().openapi({
      description: "Number of selected-wallet policy bindings.",
    }),
  })
  .openapi({ description: "API-key policy-control inventory row." });

export const policyControlInventoryItemSchema = z.discriminatedUnion("targetType", [
  walletPolicyControlInventoryItemSchema,
  apiKeyPolicyControlInventoryItemSchema,
]);

export const policyControlInventoryResponseSchema = withOpenApi(
  z.object({
    controls: z.array(policyControlInventoryItemSchema),
    total: z.number().int().nonnegative().openapi({
      description: "Rows matching target, query, and status filters.",
    }),
    page: z.number().int().positive().openapi({ description: "Current page number." }),
    pageSize: z.number().int().positive().max(100).openapi({ description: "Items per page." }),
    summary: z.object({
      total: z.number().int().nonnegative(),
      defaultAllow: z.number().int().nonnegative(),
      draft: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      disabled: z.number().int().nonnegative(),
      totalApiKeyBindings: z.number().int().nonnegative(),
    }),
  }),
  {
    description:
      "Paginated target-bound policy controls plus status and API-key binding counts. Summary counts apply target and query filters before the optional status filter.",
  }
);

export const policyControlInventoryQuerySchema = policyControlInventoryQuerySchemaBase.extend({
  target: withOpenApi(policyControlInventoryQuerySchemaBase.shape.target, {
    description: "Control-target family to return.",
    example: "all",
  }),
  status: withOpenApi(policyControlInventoryQuerySchemaBase.shape.status, {
    description: "Optional computed control status.",
    example: "active",
  }),
  query: withOpenApi(policyControlInventoryQuerySchemaBase.shape.query, {
    description: "Case-insensitive substring match on wallet display name or API-key label.",
    example: "Treasury",
  }),
  page: withOpenApi(policyControlInventoryQuerySchemaBase.shape.page, {
    description: "Page number (1-based).",
    example: 1,
  }),
  pageSize: withOpenApi(policyControlInventoryQuerySchemaBase.shape.pageSize, {
    description: "Items per page (max 100).",
    example: 25,
  }),
});
