import { COUNTRY_CODES, type CountryCode } from "@sdp/types";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";

export function generateCounterpartyProviderAccountId(): string {
  return `counterparty_provider_account_${crypto.randomUUID()}`;
}

export const counterpartyProviderAccountRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  counterparty_id: z.string(),
  provider: z.enum(RAMP_PROVIDERS),
  provider_customer_reference: z.string(),
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

export interface UpsertCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
  providerCustomerReference: string;
}

export interface GetCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
}

export interface ListActiveExternalAccountsInput extends GetCounterpartyProviderAccountInput {
  fiatCurrency: string;
  destinationCountry: CountryCode;
}

export interface ListExternalAccountsInput extends GetCounterpartyProviderAccountInput {
  fiatCurrency: string;
}

export interface ListProviderAccountsInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider?: RampProviderId;
  fiatCurrency?: string;
  destinationCountry?: CountryCode;
}

export interface GetExternalAccountByIdInput extends GetCounterpartyProviderAccountInput {
  id: string;
}

export interface InsertPendingExternalAccountInput extends ListActiveExternalAccountsInput {
  providerCustomerReference: string;
  paymentRail: string;
}

export interface CompleteExternalAccountInput extends GetCounterpartyProviderAccountInput {
  id: string;
  externalAccountReference: string;
  providerStatus: string;
}

export interface UpdateExternalAccountStatusInput extends GetCounterpartyProviderAccountInput {
  id: string;
  providerStatus: string;
  paymentRail?: string;
}

export interface ArchiveExternalAccountInput extends GetCounterpartyProviderAccountInput {
  id: string;
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
   *
   * @param input - Tenant scope, counterparty, provider, and the provider-side reference.
   * @returns The linked row, carrying the canonical reference.
   */
  upsertProviderAccount(
    input: UpsertCounterpartyProviderAccountInput
  ): Promise<CounterpartyProviderAccountRow>;

  /**
   * Lists active external accounts for one payout corridor.
   *
   * @param input - Tenant scope, counterparty, provider, currency, and country.
   * @returns All active external account rows for the corridor.
   */
  listActiveExternalAccounts(
    input: ListActiveExternalAccountsInput
  ): Promise<CounterpartyProviderAccountRow[]>;

  /**
   * Reads one external account by id within its counterparty and tenant scope.
   *
   * @param input - Tenant scope, counterparty, provider, and row id.
   * @returns The external account row, or null when it is outside the scope.
   */
  getExternalAccountById(
    input: GetExternalAccountByIdInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Lists active external accounts for one counterparty and fiat currency.
   *
   * @param input - Tenant scope, counterparty, provider, and currency.
   * @returns Active corridor rows with provider statuses.
   */
  listExternalAccounts(input: ListExternalAccountsInput): Promise<CounterpartyProviderAccountRow[]>;

  /**
   * Lists all external provider-account rows for one counterparty.
   *
   * @param input - Tenant, project, counterparty, and optional corridor filters.
   * @returns Active and archived external-account rows in creation order.
   */
  listProviderAccounts(input: ListProviderAccountsInput): Promise<CounterpartyProviderAccountRow[]>;

  /**
   * Inserts an active corridor row before provider account creation.
   *
   * @param input - Tenant scope, corridor, provider customer reference, and payment rail.
   * @returns The inserted row.
   */
  insertPendingExternalAccount(
    input: InsertPendingExternalAccountInput
  ): Promise<CounterpartyProviderAccountRow>;

  /**
   * Stores the provider reference and status on a reserved corridor row.
   *
   * @param input - Tenant scope, row id, provider reference, and status.
   * @returns The completed row or null when it is outside the scope.
   */
  completeExternalAccount(
    input: CompleteExternalAccountInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Mirrors the current provider status and, when provided, payment rail for an active corridor row.
   *
   * @param input - Tenant scope, row id, provider status, and optional payment rail.
   * @returns The updated row or null when it is outside the scope.
   */
  updateExternalAccountStatus(
    input: UpdateExternalAccountStatusInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Archives an active corridor row.
   *
   * @param input - Tenant scope and row id.
   * @returns The archived row or null when it is outside the scope.
   */
  archiveExternalAccount(
    input: ArchiveExternalAccountInput
  ): Promise<CounterpartyProviderAccountRow | null>;
}
