import type { RampProviderId } from "@sdp/types/provider-access";

export function generateCounterpartyProviderAccountId(): string {
  return `counterparty_provider_account_${crypto.randomUUID()}`;
}

export interface CounterpartyProviderAccountRow {
  id: string;
  organization_id: string;
  project_id: string;
  counterparty_id: string;
  provider: RampProviderId;
  provider_customer_reference: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UpsertCounterpartyProviderAccountInput {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  provider: RampProviderId;
  providerCustomerReference: string;
}

export interface CounterpartyProviderAccountsRepository {
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
}
