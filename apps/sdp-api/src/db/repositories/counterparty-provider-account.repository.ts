import {
  BVNK_CRYPTO_CURRENCIES,
  BVNK_NETWORKS,
  type BvnkOnrampRequestSpec,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkSessionAgreementSchema,
  bvnkVerificationStatusSchema,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { HERCLE_VERIFICATION_STATUSES } from "@sdp/payments/ramps/providers/hercle/provider-data";
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

export const counterpartyProviderAccountRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  counterparty_id: z.string(),
  provider: z.enum(RAMP_PROVIDERS),
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

export const bvnkCustomerProviderAccountMetadataSchema = z.object({
  status: z.string().optional(),
  verificationStatus: bvnkVerificationStatusSchema.optional(),
  residenceCountryCode: z.enum(COUNTRY_CODES).optional(),
  session: z
    .object({
      reference: z.string().min(1),
      signedAt: z.string().datetime().optional(),
      consentSubmittedAt: z.string().datetime().optional(),
      agreements: z.array(bvnkSessionAgreementSchema.omit({ status: true })),
    })
    .optional(),
});
export type BvnkCustomerProviderAccountMetadata = z.infer<
  typeof bvnkCustomerProviderAccountMetadataSchema
>;

/**
 * Hercle `customer_link` metadata. The reference is the counterparty id the sub-account was
 * registered under; the verification lifecycle is normalised at write time. The hosted verification
 * link is minted per read and never stored, and nothing about the business itself lands here.
 */
export const hercleCustomerLinkMetadataSchema = z.object({
  externalReference: z.string().min(1),
  verificationStatus: z.enum(HERCLE_VERIFICATION_STATUSES).optional(),
});
export type HercleCustomerLinkMetadata = z.infer<typeof hercleCustomerLinkMetadataSchema>;

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

export interface AssignCustomerLinkReferenceInput extends GetCounterpartyProviderAccountInput {
  id: string;
  /** CAS: the customer-link alias the row must still carry for the assignment to land. */
  fromProviderCustomerReference: string;
  /** The v1 customer reference replacing the alias. */
  providerCustomerReference: string;
  /** Replaces the row's metadata (the caller passes the parsed `{status}` shape). */
  metadata: Record<string, unknown>;
}

export interface GetExternalAccountByIdInput extends GetCounterpartyProviderAccountInput {
  id: string;
}

export interface SetCustomerLinkSessionInput extends GetCounterpartyProviderAccountInput {
  id: string;
  /** The minted agreement session, CAS-written only while the row carries none yet. */
  session: NonNullable<BvnkCustomerProviderAccountMetadata["session"]>;
}

export interface FindCustomerLinkBySessionReferenceInput {
  provider: RampProviderId;
  sessionReference: string;
}

export type BvnkSessionTimestampField = "signedAt" | "consentSubmittedAt";

export interface MarkCustomerLinkSessionTimestampInput extends GetCounterpartyProviderAccountInput {
  id: string;
  sessionReference: string;
  field: BvnkSessionTimestampField;
  timestamp: string;
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
   * Replaces the provider customer reference on a customer-link row via a
   * compare-and-swap against the stored pre-customer alias, replacing the
   * metadata with the caller's blob. A concurrent create that already
   * assigned the reference makes the update match zero rows and return null
   * instead of overwriting the newer reference.
   *
   * @param input - Tenant scope, row id, the alias to swap from, the v1 reference to swap to, and the replacement metadata.
   * @returns The updated row, or null when the CAS alias is gone.
   */
  assignCustomerLinkReference(
    input: AssignCustomerLinkReferenceInput
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
   * CAS-writes the minted agreement session onto a customer-link row. The
   * update matches only while the row still carries no session, so a
   * concurrent mint that stored one first makes this return null instead of
   * overwriting it — the caller must re-read and present the winner's row.
   *
   * @param input - Tenant scope, row id, and the session to store.
   * @returns The updated row, or null when a concurrent mint already stored a session.
   */
  setCustomerLinkSession(
    input: SetCustomerLinkSessionInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * Finds an active customer link by its BVNK agreement-session reference.
   * This is system-scoped because webhook payloads carry no tenant identity.
   *
   * @param input - Provider and stored agreement-session reference.
   * @returns The matching customer-link row, or null when no active row owns the session.
   */
  findCustomerLinkBySessionReference(
    input: FindCustomerLinkBySessionReferenceInput
  ): Promise<CounterpartyProviderAccountRow | null>;

  /**
   * CAS-marks an agreement-session timestamp field on an active customer link.
   * The write lands only while the session still lacks that field, so a
   * replayed signature or consent event loses the CAS instead of overwriting
   * the earlier record.
   *
   * @param input - Tenant scope, row id, provider, session reference, the timestamp field to record, and its value.
   * @returns The updated row, or null when the field was already set or the row is outside the scope.
   */
  markCustomerLinkSessionTimestamp(
    input: MarkCustomerLinkSessionTimestampInput
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
