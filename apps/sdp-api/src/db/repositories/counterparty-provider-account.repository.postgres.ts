import { COUNTERPARTY_PROVIDER_ACCOUNT_LISTED_KINDS } from "@sdp/types";
import type { AppDb } from "@/db";
import { buildInClause } from "@/db/postgres-utils";
import { internalError } from "@/lib/errors";
import type {
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
  GetCounterpartyProviderAccountInput,
  ListProviderAccountsInput,
  UpsertCounterpartyProviderAccountInput,
} from "./counterparty-provider-account.repository";
import {
  counterpartyProviderAccountRowSchema,
  generateCounterpartyProviderAccountId,
} from "./counterparty-provider-account.repository";

function parseProviderAccountRow(row: Record<string, unknown>): CounterpartyProviderAccountRow {
  const parsed = counterpartyProviderAccountRowSchema.parse(row);
  return parsed;
}

function parseProviderAccountRows(
  rows: Record<string, unknown>[]
): CounterpartyProviderAccountRow[] {
  return rows.map((row) => parseProviderAccountRow(row));
}

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
             AND provider = ?
             AND kind = 'customer_link'
             AND status = 'active'`
        )
        .bind(input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : parseProviderAccountRow(row);
    },
    async upsertProviderAccount(input: UpsertCounterpartyProviderAccountInput) {
      const metadataColumns = input.metadata === undefined ? "" : ", metadata";
      const metadataValues = input.metadata === undefined ? "" : ", ?";
      const metadataClaim = input.metadata === undefined ? "" : "EXCLUDED.metadata || ";
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider, provider_customer_reference, kind${metadataColumns}
           ) VALUES (?, ?, ?, ?, ?, ?, 'customer_link'${metadataValues})
           ON CONFLICT (counterparty_id, provider) WHERE kind = 'customer_link'
           DO UPDATE SET
             status = 'active',
             updated_at = sdp_iso_now(),
             metadata = ${metadataClaim}(CASE
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
               END)
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
          input.providerCustomerReference,
          ...(input.metadata === undefined ? [] : [input.metadata])
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("Counterparty provider-account upsert escaped its tenant scope.");
      }
      return parseProviderAccountRow(row);
    },

    async listProviderAccounts(input: ListProviderAccountsInput) {
      const conditions = [
        "organization_id = ?",
        "project_id = ?",
        "counterparty_id = ?",
        `kind IN (${buildInClause(COUNTERPARTY_PROVIDER_ACCOUNT_LISTED_KINDS.length)})`,
      ];
      const bindings: string[] = [
        input.organizationId,
        input.projectId,
        input.counterpartyId,
        ...COUNTERPARTY_PROVIDER_ACCOUNT_LISTED_KINDS,
      ];

      if (input.provider !== undefined) {
        conditions.push("provider = ?");
        bindings.push(input.provider);
      }
      if (input.fiatCurrency !== undefined) {
        conditions.push("(kind = 'customer_link' OR fiat_currency = ?)");
        bindings.push(input.fiatCurrency);
      }
      if (input.destinationCountry !== undefined) {
        conditions.push("(kind = 'customer_link' OR destination_country = ?)");
        bindings.push(input.destinationCountry);
      }

      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at ASC`
        )
        .bind(...bindings)
        .all<Record<string, unknown>>();

      return parseProviderAccountRows(result.results);
    },
  };
}
