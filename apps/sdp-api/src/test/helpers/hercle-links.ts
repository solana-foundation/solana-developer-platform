import { getDb } from "@/db/client";
import type { GetCounterpartyProviderAccountInput } from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { env } from "@/test/helpers/env";

/** Whole seconds `secondsAgo` before now, as Hercle stamps its events. */
export function hercleSecondsAgo(secondsAgo: number): number {
  return Math.floor(Date.now() / 1000) - secondsAgo;
}

/**
 * Links a counterparty to a Hercle account and records `providerStatus` on it, observed an hour ago by default.
 * A read or event the test makes now is newer, so it replaces the seeded status.
 *
 * @param scope - The counterparty's tenant scope.
 * @param accountId - The Hercle account id.
 * @param providerStatus - The status to record, or null for none.
 * @param observedAtSeconds - When Hercle reported it, in Unix seconds.
 */
export async function seedHercleLink(
  scope: Omit<GetCounterpartyProviderAccountInput, "provider">,
  accountId: string,
  providerStatus: string | null,
  observedAtSeconds = hercleSecondsAgo(3600)
): Promise<void> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const linkScope = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    counterpartyId: scope.counterpartyId,
    provider: "hercle" as const,
  };
  await accounts.upsertProviderAccount({ ...linkScope, providerCustomerReference: accountId });
  await accounts.recordCustomerLinkStatus({
    ...linkScope,
    observation: {
      providerStatus,
      observedAt: new Date(observedAtSeconds * 1000).toISOString(),
      winsTie: true,
      preserves: [],
    },
  });
}
