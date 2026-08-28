import type { RampProviderId } from "@sdp/types/provider-access";
import type { AppDb } from "@/db";
import type {
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
  UpsertCounterpartyProviderAccountInput,
} from "./counterparty-provider-account.repository";
import { generateCounterpartyProviderAccountId } from "./counterparty-provider-account.repository";

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Counterparty provider account ${field} is missing`);
  }
  return value;
}

function mapRow(row: Record<string, unknown>): CounterpartyProviderAccountRow {
  return {
    id: assertString(row.id, "id"),
    organization_id: assertString(row.organization_id, "organization_id"),
    project_id: assertString(row.project_id, "project_id"),
    counterparty_id: assertString(row.counterparty_id, "counterparty_id"),
    provider: assertString(row.provider, "provider") as RampProviderId,
    provider_customer_reference: assertString(
      row.provider_customer_reference,
      "provider_customer_reference"
    ),
    status: assertString(row.status, "status"),
    metadata: row.metadata as Record<string, unknown>,
    created_at: assertString(row.created_at, "created_at"),
    updated_at: assertString(row.updated_at, "updated_at"),
  };
}

export function createPostgresCounterpartyProviderAccountsRepository(
  db: AppDb
): CounterpartyProviderAccountsRepository {
  return {
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
      return mapRow(row);
    },
  };
}
