import { COUNTERPARTY_ENTITY_TYPES, COUNTRY_CODES, RAMP_PROVIDERS } from "@sdp/types";
import { rampDirectionSchema as rampDirectionSchemaBase } from "@/routes/payments/ramps/schemas";
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

const [onrampRequirementsQuerySchema, offrampRequirementsProviderQuerySchema] =
  counterpartyRequirementsQuerySchemaBase.options;
const [lightsparkOfframpRequirementsQuerySchema, otherOfframpRequirementsQuerySchema] =
  offrampRequirementsProviderQuerySchema.options;

export const counterpartyRequirementsQuerySchema = z
  .object({
    provider: withOpenApi(
      z.union([
        onrampRequirementsQuerySchema.shape.provider,
        lightsparkOfframpRequirementsQuerySchema.shape.provider,
        otherOfframpRequirementsQuerySchema.shape.provider,
      ]),
      { description: "Ramp provider to evaluate.", example: "moonpay" }
    ),
    direction: withOpenApi(rampDirectionSchemaBase, {
      description: "Ramp direction.",
      example: "onramp",
    }),
    assetRail: withOpenApi(onrampRequirementsQuerySchema.shape.assetRail, {
      description: "Canonical SDP crypto asset rail.",
      example: "sol.solana",
    }),
    fiatCurrency: withOpenApi(onrampRequirementsQuerySchema.shape.fiatCurrency, {
      description: "Fiat currency code.",
      example: "USD",
    }),
    destinationCustodyWalletId: withOpenApi(
      onrampRequirementsQuerySchema.shape.destinationCustodyWalletId.optional(),
      {
        description:
          "Custody wallet ID (the `id` returned by the wallets API). Required when direction is onramp.",
        example: "cwlt_example",
      }
    ),
    destinationCountry: withOpenApi(z.string().optional(), {
      description:
        "Destination payout country as an ISO 3166-1 alpha-2 code, validated against the supported country set. Valid only for Lightspark off-ramp requirements.",
      example: "US",
    }),
  })
  .openapi({
    description:
      "Ramp provider, direction, asset pair, and (for onramps) destination wallet used to evaluate counterparty requirements.",
  });

// Examples mirror fields the providers emit today (Lightspark payout and identity
// fields, BVNK residence and due-diligence fields).
const requirementFieldIdentity = (example: { key: string; label: string }) => ({
  key: withOpenApi(z.string(), {
    description: "Field key. Nested parts use dotted keys, e.g. `customer.address.line1`.",
    example: example.key,
  }),
  label: withOpenApi(z.string(), { description: "Display label.", example: example.label }),
  required: withOpenApi(z.boolean(), {
    description: "Whether a value must be collected.",
    example: true,
  }),
});

const requirementOptionSchema = z.object({
  value: withOpenApi(z.string(), { description: "Value to submit.", example: "GIFT" }),
  label: withOpenApi(z.string(), { description: "Display label.", example: "Personal gift" }),
});

const requirementTextFieldSchema = z.object({
  kind: z.literal("text"),
  ...requirementFieldIdentity({ key: "bankAccount.sortCode", label: "Sort code" }),
  pattern: withOpenApi(z.string().optional(), {
    description: "Regular expression the value must match.",
    example: "^[0-9]{6}$",
  }),
  minLength: withOpenApi(z.number().int().nonnegative().optional(), { example: 6 }),
  maxLength: withOpenApi(z.number().int().nonnegative().optional(), { example: 6 }),
  placeholder: withOpenApi(z.string().optional(), { example: "12-34-56" }),
  mask: withOpenApi(z.string().optional(), {
    description: "Display mask for the input.",
    example: "##-##-##",
  }),
});

const requirementSelectFieldSchema = z.object({
  kind: z.literal("select"),
  ...requirementFieldIdentity({ key: "purposeOfPayment", label: "Purpose of payment" }),
  options: withOpenApi(z.array(requirementOptionSchema), {
    description: "Allowed values.",
    example: [
      { value: "GIFT", label: "Personal gift" },
      { value: "SELF", label: "Transfer to yourself" },
    ],
  }),
});

const requirementCountryFieldSchema = z.object({
  kind: z.literal("country"),
  ...requirementFieldIdentity({
    key: "taxIdentification.taxResidenceCountryCode",
    label: "Tax residence country",
  }),
  options: withOpenApi(z.array(z.string()).optional(), {
    description:
      "Subset of country codes the client may offer; absent means every supported country.",
    example: ["US"],
  }),
});

const requirementCurrencyFieldSchema = z.object({
  kind: z.literal("currency"),
  ...requirementFieldIdentity({
    key: "cdd.expectedMonthlyVolume.currency",
    label: "Expected monthly volume currency",
  }),
  options: withOpenApi(z.array(z.string()).optional(), {
    description:
      "Subset of fiat currencies the client may offer; absent means every supported currency.",
    example: ["USD", "EUR"],
  }),
});

const requirementDateFieldSchema = z.object({
  kind: z.literal("date"),
  ...requirementFieldIdentity({ key: "customer.birthDate", label: "Date of birth" }),
  before: withOpenApi(z.string().optional(), {
    description: "ISO date (YYYY-MM-DD) the collected date must fall before.",
    example: "2026-07-01",
  }),
});

const requirementFieldSchema = z.discriminatedUnion("kind", [
  requirementTextFieldSchema,
  requirementSelectFieldSchema,
  requirementCountryFieldSchema,
  requirementCurrencyFieldSchema,
  requirementDateFieldSchema,
  z.object({
    kind: z.literal("address"),
    ...requirementFieldIdentity({ key: "customer.address", label: "Residential address" }),
    fields: z.array(
      z.discriminatedUnion("kind", [
        requirementTextFieldSchema,
        requirementSelectFieldSchema,
        requirementCountryFieldSchema,
        requirementCurrencyFieldSchema,
        requirementDateFieldSchema,
      ])
    ),
  }),
]);

const countryCodeDocSchema = withOpenApi(z.string(), {
  description:
    "ISO 3166-1 alpha-2 country code. Documented as a string; the API validates against the supported country set.",
  example: "US",
});

const payoutRequirementTreeSchema = z.object({
  countryRails: withOpenApi(
    z.record(countryCodeDocSchema, z.array(z.object({ value: z.string(), label: z.string() }))),
    {
      description: "Payout rails offered for each destination country.",
      example: {
        US: [
          { value: "ACH", label: "ACH" },
          { value: "WIRE", label: "Wire" },
        ],
      },
    }
  ),
  railFields: withOpenApi(z.record(z.string(), z.array(requirementFieldSchema)), {
    description: "Fields to collect for each payout rail, keyed by rail.",
    example: {
      ACH: [
        {
          kind: "text",
          key: "bankAccount.routingNumber",
          label: "Routing number",
          required: true,
          pattern: "^[0-9]{9}$",
          minLength: 9,
          maxLength: 9,
          placeholder: "021000021",
        },
      ],
    },
  }),
  accounts: z.array(
    z.object({
      id: withOpenApi(z.string(), {
        description: "Counterparty provider-account row identifier of the payout account.",
        example: "counterparty_provider_account_example",
      }),
      destinationCountry: countryCodeDocSchema,
      paymentRail: withOpenApi(z.string().nullable(), { example: "ACH" }),
      status: withOpenApi(z.string(), {
        description: "Provider-reported external-account status.",
        example: "ACTIVE",
      }),
      bankName: withOpenApi(z.string().optional(), { example: "Example Bank" }),
      accountNumberLast4: withOpenApi(z.string().optional(), { example: "6789" }),
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
      provider: withOpenApi(z.enum(RAMP_PROVIDERS).exclude(["lightspark"]), {
        example: "moonpay",
      }),
      status: z.literal("ready"),
    }),
    z.object({
      direction: z.literal("onramp"),
      provider: z.literal("lightspark"),
      status: z.literal("ready"),
    }),
    z.object({
      direction: z.literal("offramp"),
      provider: z.literal("lightspark"),
      status: z.literal("ready"),
      providerAccountId: withOpenApi(z.string(), {
        description: "Payout account resolved for the corridor, for explicit quote selection.",
        example: "counterparty_provider_account_example",
      }),
      payout: payoutRequirementTreeSchema.optional(),
    }),
    z.object({
      ...requirementBase,
      provider: withOpenApi(z.enum(RAMP_PROVIDERS), { example: "moonpay" }),
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
      provider: z.literal("bvnk"),
      status: z.literal("collect_counterparty_residence"),
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
      provider: withOpenApi(z.enum(RAMP_PROVIDERS), { example: "bvnk" }),
      status: z.literal("unsupported"),
      reason: withOpenApi(z.string(), {
        description: "Why the provider cannot serve this counterparty or corridor.",
        example: "BVNK supports USD only.",
      }),
    }),
    z.object({
      ...requirementBase,
      provider: withOpenApi(z.enum(["lightspark", "mural"]), { example: "mural" }),
      status: z.literal("onboarding_not_started"),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("mural"),
      status: z.literal("terms_of_service_required"),
      termsOfServiceUrl: withOpenApi(z.url(), {
        description: "Provider terms-of-service link the counterparty must accept.",
        example: "https://example.com/terms-of-service",
      }),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("counterparty_collect_agreement"),
      agreements: z.array(
        z.object({
          name: withOpenApi(z.string(), {
            description: "BVNK agreement identifier (v1 agreements have no id).",
            example: "EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US",
          }),
          displayName: withOpenApi(z.string(), {
            description: "Agreement display name.",
            example: "Embedded US Partner Platform Customers Agreement",
          }),
          description: withOpenApi(z.string(), {
            description: "Agreement summary text.",
            example: "Embedded US Partner Platform Customers Agreement",
          }),
          url: withOpenApi(z.url(), {
            description: "Agreement text URL, stored statically on the customer link.",
            example: "https://help.bvnk.com/hc/en-us/sections/example",
          }),
          privacyPolicyUrl: withOpenApi(z.url(), {
            description: "Privacy policy URL, stored statically on the customer link.",
            example: "https://help.bvnk.com/hc/en-us/articles/example",
          }),
        })
      ),
    }),
    z.object({
      ...requirementBase,
      provider: withOpenApi(z.enum(["bvnk", "mural"]), { example: "bvnk" }),
      status: z.literal("customer_verification_required"),
      verificationUrl: withOpenApi(z.url(), {
        description: "Provider-hosted identity verification link for the counterparty.",
        example: "https://example.com/verify/session_example",
      }),
    }),
    z.object({
      ...requirementBase,
      provider: withOpenApi(z.enum(["bvnk", "mural"]), { example: "bvnk" }),
      status: withOpenApi(z.enum(["customer_verifying", "customer_verification_failed"]), {
        example: "customer_verifying",
      }),
    }),
    z.object({
      ...requirementBase,
      provider: z.literal("bvnk"),
      status: z.literal("counterparty_agreement_signing"),
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
      description:
        "User who created the counterparty. With an API key, this is the user who created the key.",
      example: "usr_example",
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
        example: "counterparty_account_example",
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
      example: "counterparty_account_example",
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
      entityTypes: withOpenApi(z.array(z.enum(COUNTERPARTY_ENTITY_TYPES)), {
        description: "Supported counterparty entity types.",
        example: [...COUNTERPARTY_ENTITY_TYPES],
      }),
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

const customerLinkBaseDocFields = {
  id: withOpenApi(z.string(), {
    description: "Customer-link row identifier.",
    example: "counterparty_provider_account_customer",
  }),
  status: counterpartyAccountStatusSchema,
  providerStatus: withOpenApi(z.string().nullable(), {
    description:
      "Provider-side customer status when known; for BVNK links before the customer exists, one of PENDING_AGREEMENT / AGREEMENT_SIGNED.",
    example: "ACTIVE",
  }),
  createdAt: withOpenApi(isoDateTimeSchema, {
    description: "Customer-link row creation timestamp.",
    example: "2025-01-01T00:00:00.000Z",
  }),
};

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
    fiatCurrency: withOpenApi(z.string().nullable(), {
      description: "Fiat currency for the provider account corridor. Null on customer-link rows.",
      example: "USD",
    }),
    destinationCountry: withOpenApi(z.enum(COUNTRY_CODES).nullable(), {
      description:
        "Destination country for the provider account corridor. Null on customer-link rows.",
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
    customerLink: withOpenApi(
      z
        .discriminatedUnion("provider", [
          z.object({
            provider: z.literal("bvnk"),
            ...customerLinkBaseDocFields,
            providerCustomerReference: withOpenApi(z.string().nullable(), {
              description: "BVNK customer reference; null until the v1 customer exists.",
              example: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
            }),
            residenceCountryCode: withOpenApi(z.enum(COUNTRY_CODES), {
              description: "Tax-residence country the agreement session was minted for.",
              example: "US",
            }),
            agreements: withOpenApi(
              z.array(
                z.object({
                  name: withOpenApi(z.string(), {
                    description: "Agreement identifier.",
                    example: "EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US",
                  }),
                  displayName: withOpenApi(z.string(), {
                    description: "Human-readable agreement title.",
                    example: "Embedded US Partner Platform Customers Agreement",
                  }),
                  url: withOpenApi(z.string(), {
                    description: "Agreement document URL.",
                    example: "https://help.bvnk.com/hc/en-us/sections/example",
                  }),
                  privacyPolicyUrl: withOpenApi(z.string(), {
                    description: "Privacy policy document URL.",
                    example: "https://help.bvnk.com/hc/en-us/articles/example",
                  }),
                  signedAt: withOpenApi(isoDateTimeSchema.nullable(), {
                    description:
                      "When the counterparty signed the agreement session; null while consent is pending.",
                    example: "2025-01-01T00:00:00.000Z",
                  }),
                })
              ),
              { description: "Agreements of the session with their signing state." }
            ),
          }),
          z.object({
            provider: withOpenApi(
              z.enum(RAMP_PROVIDERS.filter((provider) => provider !== "bvnk")),
              { example: "lightspark" }
            ),
            ...customerLinkBaseDocFields,
            providerCustomerReference: withOpenApi(z.string(), {
              description: "Provider-side customer identifier for the counterparty.",
              example: "Customer:0193b2c4",
            }),
          }),
        ])
        .optional(),
      {
        description:
          "The counterparty's provider customer link, present once the provider onboarding has started.",
      }
    ),
    providerAccountReference: withOpenApi(z.string().optional(), {
      description:
        "The provider's own wallet/account id; present on wallet kinds once the provider assigned it.",
      example: "a:26091815750755:c1aVEgc:1",
    }),
    balance: withOpenApi(
      z
        .discriminatedUnion("state", [
          z.object({
            state: z.literal("available"),
            amount: withOpenApi(z.string(), {
              description: "Live wallet balance as a decimal string.",
              example: "9.90",
            }),
            currency: withOpenApi(z.string(), {
              description: "Balance currency.",
              example: "USD",
            }),
          }),
          z.object({
            state: z.literal("unavailable"),
          }),
        ])
        .optional(),
      {
        description:
          "Live provider-wallet balance, fetched just in time; present only on wallet kinds whose reference exists. unavailable keeps the row visible when the provider read fails.",
      }
    ),
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
