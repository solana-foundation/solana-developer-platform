import { COUNTRY_CODES, type CountryCode } from "@sdp/types";
import { PERSISTED_RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { internalError } from "@/lib/errors";

export function generateCounterpartyProviderAccountId(): string {
  return `counterparty_provider_account_${crypto.randomUUID()}`;
}

/** Strips the `counterparty_provider_account_` prefix, returning the row's 36-char uuid. */
export function counterpartyProviderAccountUuid(id: string): string {
  const match = /^counterparty_provider_account_([0-9a-f-]{36})$/.exec(id);
  if (match === null) {
    throw internalError("Counterparty provider-account id is not a prefixed uuid.");
  }
  return match[1];
}

export const counterpartyProviderAccountRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  counterparty_id: z.string(),
  // A retired provider's row still reads; writes take a live `RampProviderId`.
  provider: z.enum(PERSISTED_RAMP_PROVIDERS),
  provider_customer_reference: z.string(),
  kind: z.enum(["customer_link", "payout_account", "funding_wallet", "merchant_wallet"]),
  external_account_reference: z.string().nullable(),
  fiat_currency: z.string().nullable(),
  destination_country: z.enum(COUNTRY_CODES).nullable(),
  payment_rail: z.string().nullable(),
  provider_status: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CounterpartyProviderAccountRow = z.infer<typeof counterpartyProviderAccountRowSchema>;
export type CounterpartyProviderAccountKind = CounterpartyProviderAccountRow["kind"];

export interface UpsertCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
  providerCustomerReference: string;
  metadata?: Record<string, unknown>;
}

export interface GetCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
}

export interface ListProviderAccountsInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider?: RampProviderId;
  fiatCurrency?: string;
  destinationCountry?: CountryCode;
}

export interface CounterpartyProviderAccountsRepository {
  /**
   * Reads the provider-side customer link for one counterparty and provider.
   *
   * @param input - Tenant scope, counterparty, and provider.
   * @returns The linked row, or null when the counterparty has no provider customer yet.
   */
  getProviderAccount(
    input: GetCounterpartyProviderAccountInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Links a counterparty to its provider-side customer identity. The first
   * reference seen is canonical: a later event reporting a different customer
   * does not overwrite it — the displaced reference is appended to
   * `metadata.mismatchedReferences` so drift is observable instead of silent.
   * Metadata is a claim with the same rule: keys already stored win, incoming
   * keys only fill gaps, so a concurrent claim cannot change a stored value.
   *
   * @param input - Tenant scope, counterparty, provider, the provider-side reference, and the claimed metadata.
   * @returns The linked row, carrying the canonical reference and metadata.
   */
  upsertProviderAccount(
    input: UpsertCounterpartyProviderAccountInput
  ): Promise<CounterpartyProviderAccountRow>;

  /**
   * Lists all payout-account, customer-link, and funding-wallet rows for one
   * counterparty. Corridor filters apply to payout accounts and funding
   * wallets (which carry a fiat currency); customer links carry no corridor
   * and are always included for the matching providers.
   *
   * @param input - Tenant, project, counterparty, and optional corridor filters.
   * @returns Active and archived rows in creation order.
   */
  listProviderAccounts(input: ListProviderAccountsInput): Promise<CounterpartyProviderAccountRow[]>;
}
