import {
  COUNTERPARTY_ACCOUNT_KINDS,
  COUNTERPARTY_ENTITY_TYPES,
  type Counterparty,
  type CounterpartyAccount,
  type CounterpartyProviderAccount,
} from "@sdp/types/counterparties";
import { COUNTRY_CODES } from "@sdp/types/countries";
import { PERSISTED_RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";

const recordStatusSchema = z.enum(["active", "archived"]);

export const counterpartySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string(),
  projectId: z.string().nullable(),
  externalId: z.string().nullable(),
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
  displayName: z.string(),
  status: recordStatusSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Counterparty>;

export const counterpartyAccountSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string(),
  projectId: z.string(),
  counterpartyId: z.string(),
  accountKind: z.enum(COUNTERPARTY_ACCOUNT_KINDS),
  label: z.string().nullable(),
  details: z.looseObject({ address: z.string() }),
  providerAccountData: z.record(z.string(), z.unknown()),
  status: recordStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<CounterpartyAccount>;

const providerCustomerLinkSchema = z.object({
  id: z.string(),
  status: recordStatusSchema,
  providerStatus: z.string().nullable(),
  createdAt: z.string(),
  provider: z.enum(PERSISTED_RAMP_PROVIDERS),
  providerCustomerReference: z.string(),
});

export const counterpartyProviderAccountSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(PERSISTED_RAMP_PROVIDERS),
  kind: z.enum(["customer_link", "payout_account", "funding_wallet", "merchant_wallet"]),
  fiatCurrency: z.string().nullable(),
  destinationCountry: z.enum(COUNTRY_CODES).nullable(),
  paymentRail: z.string().nullable(),
  status: recordStatusSchema,
  providerStatus: z.string().nullable(),
  createdAt: z.string(),
  customerLink: providerCustomerLinkSchema.optional(),
  providerAccountReference: z.string().optional(),
  balance: z
    .discriminatedUnion("state", [
      z.object({ state: z.literal("available"), amount: z.string(), currency: z.string() }),
      z.object({ state: z.literal("unavailable") }),
    ])
    .optional(),
}) satisfies z.ZodType<CounterpartyProviderAccount>;

export const counterpartyResponseSchema = z.object({
  data: z.object({ counterparty: counterpartySchema }),
});

export const counterpartiesPageResponseSchema = z.object({
  data: z.object({
    counterparties: z.array(counterpartySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
});

export const counterpartyAccountsResponseSchema = z.object({
  data: z.object({
    accounts: z.array(counterpartyAccountSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
});

export const counterpartyProviderAccountsResponseSchema = z.object({
  data: z.object({ accounts: z.array(counterpartyProviderAccountSchema) }),
});
