import type { AppDb } from "@/db";
import type {
  CounterpartyProviderAccountsRepository,
  GetCounterpartyProviderAccountInput,
  UpsertCounterpartyProviderAccountInput,
} from "./counterparty-provider-account.repository";
import {
  counterpartyProviderAccountRowSchema,
  generateCounterpartyProviderAccountId,
} from "./counterparty-provider-account.repository";

export function createPostgresCounterpartyProviderAccountsRepository(
  db: AppDb
): CounterpartyProviderAccountsRepository {
  return {
    async getProviderAccount(input: GetCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?`
        )
        .bind(input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row ? counterpartyProviderAccountRowSchema.parse(row) : null;
    },
    async upsertProviderAccount(input: UpsertCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider, provider_customer_reference
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (counterparty_id, provider)
           DO UPDATE SET
             status = 'active',
             updated_at = sdp_iso_now(),
             metadata = CASE
               WHEN counterparty_provider_accounts.provider_customer_reference
                    = EXCLUDED.provider_customer_reference
                 THEN counterparty_provider_accounts.metadata
               WHEN coalesce(counterparty_provider_accounts.metadata -> 'mismatchedReferences', '[]'::jsonb)
                    @> to_jsonb(EXCLUDED.provider_customer_reference)
                 THEN counterparty_provider_accounts.metadata
               ELSE jsonb_set(
                 counterparty_provider_accounts.metadata,
                 '{mismatchedReferences}',
                 coalesce(counterparty_provider_accounts.metadata -> 'mismatchedReferences', '[]'::jsonb)
                   || to_jsonb(EXCLUDED.provider_customer_reference)
               )
             END
           WHERE counterparty_provider_accounts.organization_id = EXCLUDED.organization_id
             AND counterparty_provider_accounts.project_id = EXCLUDED.project_id
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference
        )
        .first<Record<string, unknown>>();

      if (!row) {
        throw new Error("Counterparty provider account upsert conflicted outside the tenant scope");
      }
      return counterpartyProviderAccountRowSchema.parse(row);
    },
  };
}
