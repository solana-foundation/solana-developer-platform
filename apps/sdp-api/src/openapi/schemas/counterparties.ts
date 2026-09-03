import { COUNTERPARTY_ENTITY_TYPES, COUNTRY_CODES, RAMP_PROVIDERS } from "@sdp/types";
import {
  counterpartyEntityTypeSchema as counterpartyEntityTypeSchemaBase,
  counterpartyIdParamsSchema as counterpartyIdParamsSchemaBase,
  counterpartyRequirementsQuerySchema as counterpartyRequirementsQuerySchemaBase,
  counterpartyStatusSchema as counterpartyStatusSchemaBase,
  createCounterpartySchema as createCounterpartySchemaBase,
  listCounterpartiesQuerySchema as listCounterpartiesQuerySchemaBase,
  updateCounterpartyObjectSchema as updateCounterpartyObjectSchemaBase,
} from "../../routes/counterparties/schemas";
import {
  counterpartyAccountKindSchema as counterpartyAccountKindSchemaBase,
  counterpartyAccountParamsSchema as counterpartyAccountParamsSchemaBase,
  createCounterpartyAccountSchema as createCounterpartyAccountSchemaBase,
  listCounterpartyAccountsQuerySchema as listCounterpartyAccountsQuerySchemaBase,
  updateCounterpartyAccountObjectSchema as updateCounterpartyAccountSchemaBase,
} from "../../routes/counterparty-accounts/schemas";
import { listCounterpartyProviderAccountsQuerySchema as listCounterpartyProviderAccountsQuerySchemaBase } from "../../routes/counterparty-provider-accounts/schemas";
import { rampDirectionSchema as rampDirectionSchemaBase } from "../../routes/payments/schemas";
import {
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  userIdSchema,
  withOpenApi,
  z,
} from "./base";

export const counterpartyIdParamSchema = withOpenApi(
  counterpartyIdParamsSchemaBase.shape.counterpartyId,
  {
    description: "Counterparty identifier.",
    example: "cpty_example",
  }
);

export const counterpartyEntityTypeSchema = withOpenApi(counterpartyEntityTypeSchemaBase, {
  description: "Counterparty entity type.",
  example: "individual",
});

export const counterpartyStatusSchema = withOpenApi(counterpartyStatusSchemaBase, {
  description: "Counterparty status.",
  example: "active",
});

const [onrampRequirementsQuerySchema, offrampRequirementsQuerySchema] =
  counterpartyRequirementsQuerySchemaBase.options;

export const counterpartyRequirementsQuerySchema = z
  .object({
    provider: withOpenApi(
      z.union([
        onrampRequirementsQuerySchema.shape.provider,
        offrampRequirementsQuerySchema.shape.provider,
      ]),
      { description: "Ramp provider to evaluate.", example: "moonpay" }
    ),
    direction: withOpenApi(rampDirectionSchemaBase, {
      description: "Ramp direction.",
      example: "onramp",
    }),
    cryptoToken: withOpenApi(onrampRequirementsQuerySchema.shape.cryptoToken, {
      description: "Crypto asset symbol.",
      example: "USDC",
    }),
    fiatCurrency: withOpenApi(onrampRequirementsQuerySchema.shape.fiatCurrency, {
      description: "Fiat currency code.",
      example: "USD",
    }),
    destinationWallet: withOpenApi(
      onrampRequirementsQuerySchema.shape.destinationWallet.optional(),
      {
        description: "Destination wallet ID. Required when direction is onramp.",
        example: "privy_wallet_123",
      }
    ),
  })
  .openapi({
    description:
      "Ramp provider, direction, asset pair, and (for onramps) destination wallet used to evaluate counterparty requirements.",
  });

const requirementTextFieldSchema = z.object({
  kind: z.literal("text"),
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  pattern: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  placeholder: z.string().optional(),
  mask: z.string().optional(),
});

const requirementSelectFieldSchema = z.object({
  kind: z.literal("select"),
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
});

const requirementCountryFieldSchema = z.object({
  kind: z.literal("country"),
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
});

const requirementDateFieldSchema = z.object({
  kind: z.literal("date"),
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  before: z.string().optional(),
});

const requirementFieldSchema = z.discriminatedUnion("kind", [
  requirementTextFieldSchema,
  requirementSelectFieldSchema,
  requirementCountryFieldSchema,
  requirementDateFieldSchema,
  z.object({
    kind: z.literal("address"),
    key: z.string(),
    label: z.string(),
    required: z.boolean(),
    fields: z.array(
      z.discriminatedUnion("kind", [
        requirementTextFieldSchema,
        requirementSelectFieldSchema,
        requirementCountryFieldSchema,
        requirementDateFieldSchema,
      ])
    ),
  }),
]);

const payoutRequirementTreeSchema = z.object({
  countryRails: z.partialRecord(
    z.enum(COUNTRY_CODES),
    z.array(z.object({ value: z.string(), label: z.string() }))
  ),
  railFields: z.record(z.string(), z.array(requirementFieldSchema)),
  accounts: z.array(
    z.object({
      id: z.string(),
      destinationCountry: z.enum(COUNTRY_CODES),
      paymentRail: z.string().nullable(),
      status: z.string(),
      bankName: z.string().optional(),
      accountNumberLast4: z.string().optional(),
    })
  ),
});

const requirementBase = {
  direction: withOpenApi(rampDirectionSchemaBase, {
    description: "Ramp direction evaluated for this counterparty.",
    example: "onramp",
  }),
};

/**
 * Provider/status combinations intentionally mirror the runtime
 * `CounterpartyRequirements` union. Keep this schema aligned with that model
 * when providers gain or lose requirement states.
 */
export const counterpartyRequirementsResponseSchema = withOpenApi(
  z.union([
    z.object({
      ...requirementBase,
      provider: z.enum(RAMP_PROVIDERS),
      status: z.literal("ready"),
      providerAccountId: z.string().optional(),
    }),
    z.object({
      ...requirementBase,
      provider: z.enum(RAMP_PROVIDERS),
      status: z.literal("collect"),
      fields: z.array(requirementFieldSchema),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("lightspark"),
      status: z.literal("collect_counterparty"),
      fields: z.array(requirementFieldSchema),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("collect_counterparty"),
      fields: z.array(requirementFieldSchema),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("lightspark"),
      status: z.literal("collect_account"),
      payout: payoutRequirementTreeSchema,
    }),
    z.object({
      ...requirementBase,
      provider: z.enum(RAMP_PROVIDERS),
      status: z.literal("unsupported"),
      reason: z.string(),
    }),
    z.object({
      ...requirementBase,
      provider: z.enum(["lightspark", "mural"]),
      status: z.literal("onboarding_not_started"),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("mural"),
      status: z.literal("terms_of_service_required"),
      termsOfServiceUrl: z.url(),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("customer_agreement_required"),
      agreements: z.array(
        z.object({
          id: z.string(),
          filename: z.string(),
          downloadUrl: z.url(),
        })
      ),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("customer_pending_agreement_acceptance"),
    }),
    z.object({
      ...requirementBase,
      provider: z.enum(["bvnk", "mural"]),
      status: z.literal("customer_verification_required"),
      verificationUrl: z.url(),
    }),
    z.object({
      ...requirementBase,
      provider: z.enum(["bvnk", "mural"]),
      status: z.enum(["customer_verifying", "customer_verification_failed"]),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("customer_funding_account_provisioning"),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("mural"),
      status: z.literal("funding_account_provisioning"),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("customer_funding_account_provisioning_failed"),
    }),
  ]),
  {
    description:
      "Current provider-specific readiness state and any fields or actions required before creating a ramp quote.",
  }
);

export const counterpartyAccountKindSchema = withOpenApi(counterpartyAccountKindSchemaBase, {
  description: "Counterparty account kind.",
  example: "crypto_wallet",
});

export const counterpartyAccountStatusSchema = z
  .enum(["active", "archived"])
  .openapi({ description: "Counterparty account status.", example: "active" });

export const counterpartySchema = withOpenApi(
  z.object({
    id: counterpartyIdParamSchema,
    organizationId: orgIdParamSchema,
    projectId: withOpenApi(projectIdParamSchema.nullable(), {
      description: "Project scope when the counterparty is project-scoped.",
    }),
    externalId: withOpenApi(z.string().nullable(), {
      description:
        "Caller-supplied opaque identifier for cross-system reference. Do not place personal data in this indexed field.",
      example: "customer_42",
    }),
    entityType: counterpartyEntityTypeSchema,
    displayName: withOpenApi(z.string(), {
      description:
        "Human-readable, searchable display name. Keep it minimal because this indexed field is not application-encrypted.",
      example: "Jane Doe",
    }),
    status: counterpartyStatusSchema,
    createdBy: withOpenApi(userIdSchema.nullable(), {
      description: "User who created the counterparty. Null when created via API key.",
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
  { description: "Counterparty record." }
);

export const counterpartyResponseSchema = withOpenApi(
  z.object({
    counterparty: counterpartySchema,
  }),
  { description: "Counterparty response payload." }
);

export const counterpartyAccountPathParamsSchema = counterpartyAccountParamsSchemaBase
  .extend({
    counterpartyId: withOpenApi(counterpartyAccountParamsSchemaBase.shape.counterpartyId, {
      description: "Counterparty identifier.",
      example: "cpty_example",
    }),
    counterpartyAccountId: withOpenApi(
      counterpartyAccountParamsSchemaBase.shape.counterpartyAccountId,
      {
        description: "Counterparty account identifier.",
        example: "cpa_example",
      }
    ),
  })
  .openapi({ description: "Counterparty account path parameters." });

export const counterpartyAccountDetailsSchema = z.record(z.string(), z.unknown()).openapi({
  description:
    'Account details. For crypto_wallet accounts, include network: "solana" and address as a Solana wallet address.',
  example: {
    network: "solana",
    address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  },
});

export const counterpartyAccountProviderDataSchema = z.record(z.string(), z.unknown()).openapi({
  description: "Provider-specific account metadata preserved by SDP.",
  example: {},
});

export const counterpartyAccountSchema = withOpenApi(
  z.object({
    id: withOpenApi(z.string(), {
      description: "Counterparty account identifier.",
      example: "cpa_example",
    }),
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    counterpartyId: counterpartyIdParamSchema,
    accountKind: counterpartyAccountKindSchema,
    label: withOpenApi(z.string().nullable(), {
      description: "Optional human-readable account label.",
      example: "USDC wallet",
    }),
    details: counterpartyAccountDetailsSchema,
    providerAccountData: counterpartyAccountProviderDataSchema,
    status: counterpartyAccountStatusSchema,
    createdAt: withOpenApi(isoDateTimeSchema, {
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: withOpenApi(isoDateTimeSchema, {
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  }),
  { description: "Counterparty payment account record." }
);

export const counterpartyAccountResponseSchema = withOpenApi(
  z.object({
    account: counterpartyAccountSchema,
  }),
  { description: "Counterparty account response payload." }
);

export const listCounterpartyAccountsResponseSchema = withOpenApi(
  z.object({
    accounts: withOpenApi(z.array(counterpartyAccountSchema), {
      description: "Counterparty accounts.",
    }),
    total: withOpenApi(z.number().int().nonnegative(), {
      description: "Total counterparty accounts matching the query.",
      example: 2,
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
  { description: "Paginated list of counterparty accounts." }
);

export const listCounterpartiesResponseSchema = withOpenApi(
  z.object({
    counterparties: withOpenApi(z.array(counterpartySchema), {
      description: "Counterparties.",
    }),
    total: withOpenApi(z.number().int().nonnegative(), {
      description: "Total counterparties matching the query.",
      example: 42,
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
  { description: "Paginated list of counterparties." }
);

const countrySchema = withOpenApi(
  z.object({
    code: withOpenApi(z.string(), { description: "ISO 3166-1 alpha-2 code.", example: "US" }),
    name: withOpenApi(z.string(), {
      description: "English display name.",
      example: "United States",
    }),
  }),
  { description: "Country option." }
);

export const counterpartyFieldOptionsResponseSchema = withOpenApi(
  z.object({
    fields: z.object({
      entityTypes: z.array(z.enum(COUNTERPARTY_ENTITY_TYPES)),
      countries: z.array(countrySchema),
    }),
  }),
  {
    description:
      "Field option sets for building a counterparty form: closed enums plus the country list.",
  }
);

export const listCounterpartiesQuerySchema = listCounterpartiesQuerySchemaBase.extend({
  page: withOpenApi(listCounterpartiesQuerySchemaBase.shape.page, {
    description: "Page number (1-based).",
    example: 1,
  }),
  pageSize: withOpenApi(listCounterpartiesQuerySchemaBase.shape.pageSize, {
    description: "Items per page (max 100).",
    example: 20,
  }),
  includeArchived: withOpenApi(listCounterpartiesQuerySchemaBase.shape.includeArchived, {
    description: "Include archived counterparties in results.",
    example: false,
  }),
});

export const listCounterpartyAccountsQuerySchema = listCounterpartyAccountsQuerySchemaBase
  .extend({
    accountKind: withOpenApi(listCounterpartyAccountsQuerySchemaBase.shape.accountKind, {
      description: "Filter accounts by account kind.",
      example: "crypto_wallet",
    }),
    page: withOpenApi(listCounterpartyAccountsQuerySchemaBase.shape.page, {
      description: "Page number (1-based).",
      example: 1,
    }),
    pageSize: withOpenApi(listCounterpartyAccountsQuerySchemaBase.shape.pageSize, {
      description: "Items per page (max 100).",
      example: 20,
    }),
    includeArchived: withOpenApi(listCounterpartyAccountsQuerySchemaBase.shape.includeArchived, {
      description: "Include archived counterparty accounts in results.",
      example: false,
    }),
  })
  .openapi({ description: "Counterparty account list filters." });

export const counterpartyProviderAccountSchema = withOpenApi(
  z.object({
    id: withOpenApi(z.string(), {
      description: "Counterparty provider-account row identifier.",
      example: "counterparty_provider_account_example",
    }),
    provider: withOpenApi(z.enum(RAMP_PROVIDERS), {
      description: "Ramp provider owning the account.",
      example: "lightspark",
    }),
    kind: withOpenApi(
      z.enum(["customer_link", "payout_account", "funding_wallet", "merchant_wallet"]),
      {
        description: "Provider-account resource kind.",
        example: "payout_account",
      }
    ),
    fiatCurrency: withOpenApi(z.string(), {
      description: "Fiat currency for the provider account corridor.",
      example: "USD",
    }),
    destinationCountry: withOpenApi(z.enum(COUNTRY_CODES), {
      description: "Destination country for the provider account corridor.",
      example: "US",
    }),
    paymentRail: withOpenApi(z.string().nullable(), {
      description: "Payment rail selected for the corridor row.",
      example: "ACH",
    }),
    status: counterpartyAccountStatusSchema,
    providerStatus: withOpenApi(z.string().nullable(), {
      description: "Current provider-side account status when known.",
      example: "ACTIVE",
    }),
    createdAt: withOpenApi(isoDateTimeSchema, {
      description: "SDP row creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    bankName: withOpenApi(z.string().optional(), {
      description: "Bank name returned by the provider when available.",
      example: "Example Bank",
    }),
    accountNumberLast4: withOpenApi(z.string().optional(), {
      description: "Last four digits of the provider account number.",
      example: "6789",
    }),
    paymentRails: withOpenApi(z.array(z.string()).optional(), {
      description: "Payment rails returned by the provider when available.",
      example: ["ACH", "WIRE"],
    }),
  }),
  { description: "Counterparty provider-account row with optional JIT provider details." }
);

export const listCounterpartyProviderAccountsResponseSchema = withOpenApi(
  z.object({
    accounts: withOpenApi(z.array(counterpartyProviderAccountSchema), {
      description: "External provider accounts for the counterparty.",
    }),
  }),
  { description: "Counterparty provider-account list." }
);

export const listCounterpartyProviderAccountsQuerySchema =
  listCounterpartyProviderAccountsQuerySchemaBase
    .extend({
      provider: withOpenApi(listCounterpartyProviderAccountsQuerySchemaBase.shape.provider, {
        description: "Filter by ramp provider.",
        example: "lightspark",
      }),
      fiatCurrency: withOpenApi(
        listCounterpartyProviderAccountsQuerySchemaBase.shape.fiatCurrency,
        {
          description: "Filter by fiat currency.",
          example: "USD",
        }
      ),
      destinationCountry: withOpenApi(
        listCounterpartyProviderAccountsQuerySchemaBase.shape.destinationCountry,
        {
          description: "Filter by ISO 3166-1 alpha-2 destination country.",
          example: "US",
        }
      ),
    })
    .openapi({ description: "Counterparty provider-account list filters." });

const createCounterpartyDocFields = {
  externalId: withOpenApi(createCounterpartySchemaBase.shape.externalId, {
    description:
      "Caller-supplied opaque identifier for cross-system reference. Do not place personal data in this indexed field.",
    example: "customer_42",
  }),
  entityType: withOpenApi(createCounterpartySchemaBase.shape.entityType, {
    description: "Counterparty entity type.",
    example: "individual",
  }),
  displayName: withOpenApi(createCounterpartySchemaBase.shape.displayName, {
    description:
      "Human-readable, searchable display name. Keep it minimal because this indexed field is not application-encrypted.",
    example: "Jane Doe",
  }),
};

export const createCounterpartyRequestSchema = withOpenApi(
  createCounterpartySchemaBase.extend(createCounterpartyDocFields),
  { description: "Create counterparty request body." }
);

export const createCounterpartyAccountRequestSchema = withOpenApi(
  createCounterpartyAccountSchemaBase.safeExtend({
    accountKind: withOpenApi(createCounterpartyAccountSchemaBase.shape.accountKind, {
      description: "Counterparty account kind.",
      example: "crypto_wallet",
    }),
    label: withOpenApi(createCounterpartyAccountSchemaBase.shape.label, {
      description: "Optional account label.",
      example: "USDC wallet",
    }),
    details: withOpenApi(createCounterpartyAccountSchemaBase.shape.details, {
      description:
        'For crypto_wallet accounts, must include network: "solana" and address as a Solana wallet address.',
      example: {
        network: "solana",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      },
    }),
    providerAccountData: withOpenApi(
      createCounterpartyAccountSchemaBase.shape.providerAccountData,
      {
        description: "Provider-specific metadata to preserve with the account.",
        example: {},
      }
    ),
  }),
  { description: "Create counterparty account request body." }
);

export const updateCounterpartyRequestSchema = withOpenApi(
  updateCounterpartyObjectSchemaBase.extend({
    externalId: withOpenApi(updateCounterpartyObjectSchemaBase.shape.externalId, {
      description: "Updated opaque external ID. Do not include personal data. Use null to clear.",
      example: "customer_42",
    }),
    entityType: withOpenApi(updateCounterpartyObjectSchemaBase.shape.entityType, {
      description: "Updated counterparty entity type.",
      example: "business",
    }),
    displayName: withOpenApi(updateCounterpartyObjectSchemaBase.shape.displayName, {
      description: "Updated searchable display name. Keep it minimal.",
      example: "Jane Q. Doe",
    }),
  }),
  {
    description: "Update counterparty request body. At least one field must be provided.",
    minProperties: 1,
  }
);

export const updateCounterpartyAccountRequestSchema = withOpenApi(
  updateCounterpartyAccountSchemaBase.safeExtend({
    label: withOpenApi(updateCounterpartyAccountSchemaBase.shape.label, {
      description: "Updated account label. Use null to clear.",
      example: "Primary USDC wallet",
    }),
    details: withOpenApi(updateCounterpartyAccountSchemaBase.shape.details, {
      description:
        'Updated account details. Crypto-wallet accounts must retain network: "solana" and a valid Solana wallet address.',
      example: {
        network: "solana",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      },
    }),
    providerAccountData: withOpenApi(
      updateCounterpartyAccountSchemaBase.shape.providerAccountData,
      {
        description: "Updated provider-specific metadata.",
        example: {},
      }
    ),
  }),
  {
    description: "Update counterparty account request body. At least one field must be provided.",
    minProperties: 1,
  }
);
