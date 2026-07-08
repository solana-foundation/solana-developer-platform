import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import {
  counterpartyAddressSchema as counterpartyAddressSchemaBase,
  counterpartyBusinessIdentitySchema as counterpartyBusinessIdentitySchemaBase,
  counterpartyEntityTypeSchema as counterpartyEntityTypeSchemaBase,
  counterpartyIdentitySchema as counterpartyIdentitySchemaBase,
  counterpartyIdParamsSchema as counterpartyIdParamsSchemaBase,
  counterpartyStatusSchema as counterpartyStatusSchemaBase,
  createBusinessCounterpartySchema as createBusinessCounterpartySchemaBase,
  createIndividualCounterpartySchema as createIndividualCounterpartySchemaBase,
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
import {
  isoDateSchema,
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
    example: "cp_example",
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

export const counterpartyAccountKindSchema = withOpenApi(counterpartyAccountKindSchemaBase, {
  description: "Counterparty account kind.",
  example: "crypto_wallet",
});

export const counterpartyAccountStatusSchema = z
  .enum(["active", "archived"])
  .openapi({ description: "Counterparty account status.", example: "active" });

export const counterpartyAddressSchema = withOpenApi(
  counterpartyAddressSchemaBase.extend({
    line1: withOpenApi(counterpartyAddressSchemaBase.shape.line1, {
      description: "Street address line 1.",
      example: "123 Main St",
    }),
    line2: withOpenApi(counterpartyAddressSchemaBase.shape.line2, {
      description: "Street address line 2.",
      example: "Apt 4B",
    }),
    city: withOpenApi(counterpartyAddressSchemaBase.shape.city, {
      description: "City.",
      example: "San Francisco",
    }),
    postalCode: withOpenApi(counterpartyAddressSchemaBase.shape.postalCode, {
      description: "Postal or ZIP code.",
      example: "94105",
    }),
    countryCode: withOpenApi(counterpartyAddressSchemaBase.shape.countryCode, {
      description: "ISO 3166-1 country code.",
      example: "US",
    }),
    subdivisionCode: withOpenApi(counterpartyAddressSchemaBase.shape.subdivisionCode, {
      description:
        "Subdivision code (state, province, region) — bare 2-letter code (e.g. `CA`); ISO 3166-2 (`US-CA`) is also accepted, but some providers require the bare form.",
      example: "CA",
    }),
  }),
  { description: "Postal address for a counterparty." }
);

export const counterpartyIdentitySchema = withOpenApi(
  counterpartyIdentitySchemaBase.extend({
    firstName: withOpenApi(counterpartyIdentitySchemaBase.shape.firstName, {
      description: "Given name.",
      example: "Jane",
    }),
    middleName: withOpenApi(counterpartyIdentitySchemaBase.shape.middleName, {
      description: "Middle name.",
      example: "Q",
    }),
    lastName: withOpenApi(counterpartyIdentitySchemaBase.shape.lastName, {
      description: "Family name.",
      example: "Doe",
    }),
    secondLastName: withOpenApi(counterpartyIdentitySchemaBase.shape.secondLastName, {
      description: "Second family name (used in some locales).",
      example: "Garcia",
    }),
    dateOfBirth: withOpenApi(isoDateSchema, {
      description: "Date of birth (YYYY-MM-DD).",
      example: "1990-01-15",
    }),
    phone: withOpenApi(counterpartyIdentitySchemaBase.shape.phone, {
      description: "Contact phone number in E.164 format.",
      example: "+14155551234",
    }),
    address: counterpartyAddressSchema,
  }),
  {
    description: "Personal identity details for an individual counterparty.",
  }
);

export const counterpartyBusinessIdentitySchema = withOpenApi(
  counterpartyBusinessIdentitySchemaBase.extend({
    address: counterpartyAddressSchema,
  }),
  {
    description: "Business identity details: the registered address.",
  }
);

export const counterpartySchema = withOpenApi(
  z.object({
    id: counterpartyIdParamSchema,
    organizationId: orgIdParamSchema,
    projectId: withOpenApi(projectIdParamSchema.nullable(), {
      description: "Project scope when the counterparty is project-scoped.",
    }),
    externalId: withOpenApi(z.string().nullable(), {
      description: "Caller-supplied identifier for cross-system reference.",
      example: "customer_42",
    }),
    entityType: counterpartyEntityTypeSchema,
    displayName: withOpenApi(z.string(), {
      description: "Human-readable display name.",
      example: "Jane Doe",
    }),
    email: withOpenApi(z.string(), {
      description: "Primary contact email.",
      example: "jane@example.com",
    }),
    identity: withOpenApi(
      z.union([counterpartyIdentitySchema, counterpartyBusinessIdentitySchema]),
      { description: "Identity details; shape depends on entityType." }
    ),
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
      example: "cp_example",
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
      usStates: z.array(countrySchema),
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

const createCounterpartyDocFields = {
  externalId: withOpenApi(createIndividualCounterpartySchemaBase.shape.externalId, {
    description: "Caller-supplied identifier for cross-system reference.",
    example: "customer_42",
  }),
  displayName: withOpenApi(createIndividualCounterpartySchemaBase.shape.displayName, {
    description: "Human-readable display name.",
    example: "Jane Doe",
  }),
  email: withOpenApi(createIndividualCounterpartySchemaBase.shape.email, {
    description: "Primary contact email.",
    example: "jane@example.com",
  }),
};

export const createCounterpartyRequestSchema = withOpenApi(
  z.discriminatedUnion("entityType", [
    createIndividualCounterpartySchemaBase.extend({
      ...createCounterpartyDocFields,
      entityType: withOpenApi(createIndividualCounterpartySchemaBase.shape.entityType, {
        description: "Counterparty entity type.",
        example: "individual",
      }),
      identity: withOpenApi(counterpartyIdentitySchema, {
        description: "Personal identity details, required for individual counterparties.",
      }),
    }),
    createBusinessCounterpartySchemaBase.extend({
      ...createCounterpartyDocFields,
      entityType: withOpenApi(createBusinessCounterpartySchemaBase.shape.entityType, {
        description: "Counterparty entity type.",
        example: "business",
      }),
      identity: withOpenApi(counterpartyBusinessIdentitySchema, {
        description: "Business identity details: the registered address.",
      }),
    }),
  ]),
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
      description: "Updated external ID. Use null to clear.",
      example: "customer_42",
    }),
    entityType: withOpenApi(updateCounterpartyObjectSchemaBase.shape.entityType, {
      description: "Updated counterparty entity type.",
      example: "business",
    }),
    displayName: withOpenApi(updateCounterpartyObjectSchemaBase.shape.displayName, {
      description: "Updated display name.",
      example: "Jane Q. Doe",
    }),
    email: withOpenApi(updateCounterpartyObjectSchemaBase.shape.email, {
      description: "Updated contact email.",
      example: "jane.doe@example.com",
    }),
    identity: withOpenApi(
      z.union([counterpartyIdentitySchema, counterpartyBusinessIdentitySchema]).optional(),
      {
        description:
          "Updated identity details. Replaces the existing identity object and must match the counterparty's entityType.",
      }
    ),
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
