import {
  counterpartyAddressSchema as counterpartyAddressSchemaBase,
  counterpartyEntityTypeSchema as counterpartyEntityTypeSchemaBase,
  counterpartyGovernmentIdSchema as counterpartyGovernmentIdSchemaBase,
  counterpartyIdentitySchema as counterpartyIdentitySchemaBase,
  counterpartyIdSchema as counterpartyIdSchemaBase,
  counterpartyIdTypeSchema as counterpartyIdTypeSchemaBase,
  counterpartyStatusSchema as counterpartyStatusSchemaBase,
  createCounterpartySchema as createCounterpartySchemaBase,
  listCounterpartiesQuerySchema as listCounterpartiesQuerySchemaBase,
  updateCounterpartyObjectSchema as updateCounterpartyObjectSchemaBase,
} from "../../routes/counterparties/schemas";
import {
  isoDateSchema,
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  userIdSchema,
  withOpenApi,
  z,
} from "./base";

export const counterpartyIdParamSchema = withOpenApi(counterpartyIdSchemaBase, {
  description: "Counterparty identifier.",
  example: "cp_example",
});

export const counterpartyEntityTypeSchema = withOpenApi(counterpartyEntityTypeSchemaBase, {
  description: "Counterparty entity type.",
  example: "individual",
});

export const counterpartyStatusSchema = withOpenApi(counterpartyStatusSchemaBase, {
  description: "Counterparty status.",
  example: "active",
});

export const counterpartyIdTypeSchema = withOpenApi(counterpartyIdTypeSchemaBase, {
  description:
    "Government ID document type: PAS (passport), DRV (driver's license), STA (state/national ID), GOV (other government-issued).",
  example: "PAS",
});

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
      description: "ISO 3166-2 subdivision code (state, province, region).",
      example: "US-CA",
    }),
  }),
  { description: "Postal address for a counterparty." }
);

export const counterpartyGovernmentIdSchema = withOpenApi(
  counterpartyGovernmentIdSchemaBase.extend({
    type: counterpartyIdTypeSchema,
    number: withOpenApi(counterpartyGovernmentIdSchemaBase.shape.number, {
      description: "Government ID number.",
      example: "X12345678",
    }),
    issueCountry: withOpenApi(counterpartyGovernmentIdSchemaBase.shape.issueCountry, {
      description: "ISO 3166-1 country code of the issuing authority.",
      example: "US",
    }),
    subdivisionCode: withOpenApi(counterpartyGovernmentIdSchemaBase.shape.subdivisionCode, {
      description: "ISO 3166-2 subdivision code of the issuing authority.",
      example: "US-CA",
    }),
    issueDate: withOpenApi(isoDateSchema.optional(), {
      description: "Issue date (YYYY-MM-DD).",
      example: "2018-06-01",
    }),
    expiryDate: withOpenApi(isoDateSchema.optional(), {
      description: "Expiry date (YYYY-MM-DD).",
      example: "2028-06-01",
    }),
  }),
  { description: "Government-issued identity document." }
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
    dateOfBirth: withOpenApi(isoDateSchema.optional(), {
      description: "Date of birth (YYYY-MM-DD).",
      example: "1990-01-15",
    }),
    phone: withOpenApi(counterpartyIdentitySchemaBase.shape.phone, {
      description: "Contact phone number in E.164 format.",
      example: "+14155551234",
    }),
    address: counterpartyAddressSchema.optional(),
    birthCountryCode: withOpenApi(counterpartyIdentitySchemaBase.shape.birthCountryCode, {
      description: "ISO 3166-1 country code of birth.",
      example: "US",
    }),
    citizenshipCountryCode: withOpenApi(
      counterpartyIdentitySchemaBase.shape.citizenshipCountryCode,
      {
        description: "ISO 3166-1 country code of citizenship.",
        example: "US",
      }
    ),
    governmentId: counterpartyGovernmentIdSchema.optional(),
  }),
  {
    description:
      "Identity details for the counterparty. Additional provider-specific fields are accepted and preserved.",
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
    identity: counterpartyIdentitySchema,
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

export const createCounterpartyRequestSchema = withOpenApi(
  createCounterpartySchemaBase.extend({
    externalId: withOpenApi(createCounterpartySchemaBase.shape.externalId, {
      description: "Caller-supplied identifier for cross-system reference.",
      example: "customer_42",
    }),
    entityType: withOpenApi(createCounterpartySchemaBase.shape.entityType, {
      description: "Counterparty entity type.",
      example: "individual",
    }),
    displayName: withOpenApi(createCounterpartySchemaBase.shape.displayName, {
      description: "Human-readable display name.",
      example: "Jane Doe",
    }),
    email: withOpenApi(createCounterpartySchemaBase.shape.email, {
      description: "Primary contact email.",
      example: "jane@example.com",
    }),
    identity: withOpenApi(counterpartyIdentitySchema.optional(), {
      description: "Optional identity details. Required completeness depends on downstream KYC.",
    }),
  }),
  { description: "Create counterparty request body." }
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
    identity: withOpenApi(counterpartyIdentitySchema.optional(), {
      description: "Updated identity details. Replaces the existing identity object.",
    }),
  }),
  {
    description: "Update counterparty request body. At least one field must be provided.",
    minProperties: 1,
  }
);
