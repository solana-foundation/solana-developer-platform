import type { RampCustomerStatusObservation } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
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
  provider_status_observed_at: z.string().nullable(),
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
  metadata?: Record<string, unknown>;
}

export interface GetCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
}

export interface RecordCustomerLinkStatusInput extends GetCounterpartyProviderAccountInput {
  /** The provider's report of the customer's status, with when it reported it. */
  observation: RampCustomerStatusObservation;
}

/** What recording a status did: took it, kept a newer report, or found no active link. */
export type RecordCustomerLinkStatusOutcome = "recorded" | "stale" | "missing";

export interface FindCustomerLinkByProviderReferenceInput {
  provider: RampProviderId;
  providerCustomerReference: string;
}

/** A customer link found by the provider's id for the customer, with the environment of the project that holds it. */
export interface CustomerLinkWithEnvironment {
  link: CounterpartyProviderAccountRow;
  environment: SdpEnvironment;
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
   * Records the provider's status on the counterparty's active customer link, unless the link holds a newer report.
   * A report replaces one observed earlier, or a different status observed at the same instant when it wins the tie.
   * A duplicate therefore changes nothing, and a report never replaces a status it preserves.
   * The comparison and the write are one statement, so concurrent reports settle on the newest.
   *
   * @param input - Tenant scope, counterparty, provider, and the provider's report.
   * @returns Whether the link took the report, kept a newer one, or is not an active link in scope.
   */
  recordCustomerLinkStatus(
    input: RecordCustomerLinkStatusInput
  ): Promise<RecordCustomerLinkStatusOutcome>;

  /**
   * Finds the active customer link a provider names by its id for the customer, in any tenant.
   * It serves provider webhooks, which carry no tenant, so it is for system callers only.
   * Only providers whose links are unique per customer reference name one link (migration 0091).
   *
   * @param input - The provider and its id for the customer.
   * @returns The link and its project's environment, or null unless exactly one active link of an active counterparty matches.
   */
  findCustomerLinkByProviderReference(
    input: FindCustomerLinkByProviderReferenceInput
  ): Promise<CustomerLinkWithEnvironment | null>;

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
