import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import type { AppContext } from "../counterparties/context";

/**
 * Creates the provider-account repository scoped to the current request tenant.
 *
 * @param c - Authenticated request context.
 * @returns Tenant-scoped provider-account repository.
 */
export function getCounterpartyProviderAccountsRepository(c: AppContext) {
  return createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
}
