import {
  BVNK_CRYPTO_CURRENCIES,
  BVNK_NETWORKS,
  type BvnkOnrampRequestSpec,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { COUNTRY_CODES, type CountryCode } from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
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

/** Provider-side identity reference an active `customer_link` row always carries; pending claims hold NULL until the provider object exists. */
export const providerCustomerReferenceSchema = z.string().min(1);

export const counterpartyProviderAccountRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  counterparty_id: z.string(),
  provider: z.enum(RAMP_PROVIDERS),
  provider_customer_reference: z.string().nullable(),
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

const bvnkOnrampRequestSpecSchema = z.object({
  currency: z.enum(BVNK_CRYPTO_CURRENCIES),
  network: z.enum(BVNK_NETWORKS),
  destinationWalletAddress: z.string(),
  fiatCurrency: z.enum(RAMP_FIAT_CURRENCIES),
}) satisfies z.ZodType<BvnkOnrampRequestSpec>;

export const bvnkFundingWalletMetadataSchema = z.object({
  onrampKey: z.string(),
  ruleId: z.string().optional(),
  ruleStatus: z.string().optional(),
  walletName: z.string().optional(),
  request: bvnkOnrampRequestSpecSchema.optional(),
});
export type BvnkFundingWalletMetadata = z.infer<typeof bvnkFundingWalletMetadataSchema>;

export const bvnkCustomerLinkMetadataSchema = z.strictObject({});
export type BvnkCustomerLinkMetadata = z.infer<typeof bvnkCustomerLinkMetadataSchema>;

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

export interface GetAccountByKindAndCurrencyInput extends GetCounterpartyProviderAccountInput {
  kind: Exclude<CounterpartyProviderAccountKind, "customer_link">;
  fiatCurrency: string;
}

export interface GetFundingWalletByOnrampKeyInput extends GetCounterpartyProviderAccountInput {
  onrampKey: string;
}

export interface GetFundingWalletByExternalAccountReferenceInput {
  provider: RampProviderId;
  externalAccountReference: string;
}

export interface CompleteCustomerLinkInput extends GetCounterpartyProviderAccountInput {
  id: string;
  providerCustomerReference: string;
}

export const pendingCustomerLinkRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  counterparty_id: z.string(),
  provider: z.enum(RAMP_PROVIDERS),
  kind: z.literal("customer_link"),
  status: z.literal("pending"),
});
export type PendingCustomerLinkRow = z.infer<typeof pendingCustomerLinkRowSchema>;

interface InsertProviderResourceAccountBase extends GetCounterpartyProviderAccountInput {
  providerCustomerReference: string;
  fiatCurrency: string;
  externalAccountReference: string;
  providerStatus?: string;
  metadata: Record<string, unknown>;
}

export type InsertProviderResourceAccountInput = InsertProviderResourceAccountBase &
  (
    | {
        kind: "payout_account";
        destinationCountry: CountryCode;
        paymentRail?: string;
      }
    | {
        kind: "funding_wallet" | "merchant_wallet";
        destinationCountry?: never;
        paymentRail?: never;
      }
  );

export interface PatchAccountMetadataInput extends GetCounterpartyProviderAccountInput {
  id: string;
  /** Top-level keys merged into the current metadata (shallow). */
  set: Record<string, unknown>;
  /** Top-level keys removed after the merge. */
  unset: readonly string[];
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
   * Reads an active provider resource by kind and fiat currency.
   *
   * @param input - Tenant scope, counterparty, provider, kind, and currency.
   * @returns The active matching row, or null when none exists.
   */
  getAccountByKindAndCurrency(
    input: GetAccountByKindAndCurrencyInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Reads an active BVNK funding wallet by its on-ramp key.
   *
   * @param input - Tenant scope, counterparty, provider, and on-ramp key.
   * @returns The active funding-wallet row, or null when none exists.
   */
  getFundingWalletByOnrampKey(
    input: GetFundingWalletByOnrampKeyInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Reads an active funding wallet by its provider-side external account
   * reference (the BVNK wallet id). System-scoped because webhook payloads
   * carry no tenant identity; the row supplies the tenant scope.
   *
   * @param input - Provider and the external account reference to resolve.
   * @returns The active funding-wallet row, or null when none exists.
   */
  getFundingWalletByExternalAccountReference(
    input: GetFundingWalletByExternalAccountReferenceInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Claims a counterparty's BVNK customer-link slot as a pending row before
   * the provider contact is created: one row per counterparty and provider is
   * allowed across pending and active states, so the claim fences concurrent
   * advances. The row carries no provider reference until the contact exists.
   *
   * @param input - Tenant scope, counterparty, and provider.
   * @returns The claimed pending customer-link row.
   */
  claimPendingCustomerLink(
    input: GetCounterpartyProviderAccountInput
  ): Promise<PendingCustomerLinkRow>;

  /**
   * Reads the counterparty's pending customer-link row, if a crash left one
   * claimed but not yet bound to a contact.
   *
   * @param input - Tenant scope, counterparty, and provider.
   * @returns The pending row, or null when none exists.
   */
  getPendingCustomerLink(
    input: GetCounterpartyProviderAccountInput
  ): Promise<PendingCustomerLinkRow | null>;

  /**
   * Activates a pending customer-link row with the provider contact id via a
   * compare-and-swap that matches only while the row is pending and carries
   * no reference, so a concurrent completion never overwrites a newer
   * reference.
   *
   * @param input - Tenant scope, row id, and the contact id to bind.
   * @returns The active customer-link row, or null when the CAS missed.
   */
  completeCustomerLink(
    input: CompleteCustomerLinkInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Inserts an active non-customer provider resource account.
   *
   * @param input - Tenant scope, resource kind, provider references, and metadata.
   * @returns The inserted provider-account row.
   */
  insertProviderResourceAccount(
    input: InsertProviderResourceAccountInput
  ): Promise<CounterpartyProviderAccountRow>;

  /**
   * Patches metadata on an active provider-account row within its parent
   * scope: shallow-merges `set`, then removes `unset` keys. The merged
   * result must satisfy the row kind's metadata schema or the write rolls
   * back.
   *
   * @param input - Tenant scope, row id, provider, keys to merge, and keys to remove.
   * @returns The patched row, or null when it is outside the scope.
   */
  patchAccountMetadata(
    input: PatchAccountMetadataInput
  ): Promise<CounterpartyProviderAccountRow | null>;

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
   * Lists all payout-account and customer-link rows for one counterparty.
   * Corridor filters apply to payout accounts only; customer links carry no
   * corridor and are always included for the matching providers.
   *
   * @param input - Tenant, project, counterparty, and optional corridor filters.
   * @returns Active and archived rows in creation order.
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
