import { getDb } from "@/db/client";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { AppContext } from "@/routes/counterparties/context";

/**
 * Creates the provider-account repository scoped to the current request tenant.
 *
 * @param c - Authenticated request context.
 * @returns Tenant-scoped provider-account repository.
 */
export function getCounterpartyProviderAccountsRepository(c: AppContext) {
  return createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
}
