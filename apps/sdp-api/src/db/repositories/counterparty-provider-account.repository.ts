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
  status: z.string(),
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
}
