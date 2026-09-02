import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  ArchiveExternalAccountInput,
  CompleteExternalAccountInput,
  CounterpartyProviderAccountsRepository,
  GetCounterpartyProviderAccountInput,
  GetExternalAccountByIdInput,
  InsertPendingExternalAccountInput,
  ListActiveExternalAccountsInput,
  ListExternalAccountsInput,
  ListProviderAccountsInput,
  UpdateExternalAccountStatusInput,
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
             AND provider = ?
             AND fiat_currency IS NULL
             AND status = 'active'`
        )
        .bind(input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : counterpartyProviderAccountRowSchema.parse(row);
    },
    async upsertProviderAccount(input: UpsertCounterpartyProviderAccountInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider, provider_customer_reference
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (counterparty_id, provider) WHERE fiat_currency IS NULL
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

      if (row === null) {
        throw internalError("Counterparty provider-account upsert escaped its tenant scope.");
      }
      return counterpartyProviderAccountRowSchema.parse(row);
    },

    async listActiveExternalAccounts(input: ListActiveExternalAccountsInput) {
      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency = ?
             AND destination_country = ?
             AND status = 'active'
           ORDER BY created_at ASC`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency,
          input.destinationCountry
        )
        .all<Record<string, unknown>>();

      return result.results.map((row) => counterpartyProviderAccountRowSchema.parse(row));
    },

    async getExternalAccountById(input: GetExternalAccountByIdInput) {
      const row = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency IS NOT NULL`
        )
        .bind(input.id, input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : counterpartyProviderAccountRowSchema.parse(row);
    },

    async listExternalAccounts(input: ListExternalAccountsInput) {
      const result = await db
        .prepare(
          `SELECT *
           FROM counterparty_provider_accounts
           WHERE organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency = ?
             AND status = 'active'
             AND provider_status IS NOT NULL
           ORDER BY created_at ASC`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.fiatCurrency
        )
        .all<Record<string, unknown>>();

      return result.results.map((row) => counterpartyProviderAccountRowSchema.parse(row));
    },

    async listProviderAccounts(input: ListProviderAccountsInput) {
      const conditions = [
        "organization_id = ?",
        "project_id = ?",
        "counterparty_id = ?",
        "fiat_currency IS NOT NULL",
      ];
      const bindings: string[] = [input.organizationId, input.projectId, input.counterpartyId];

      if (input.provider !== undefined) {
        conditions.push("provider = ?");
        bindings.push(input.provider);
      }
      if (input.fiatCurrency !== undefined) {
        conditions.push("fiat_currency = ?");
        bindings.push(input.fiatCurrency);
      }
      if (input.destinationCountry !== undefined) {
        conditions.push("destination_country = ?");
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

      return result.results.map((row) => counterpartyProviderAccountRowSchema.parse(row));
    },

    async insertPendingExternalAccount(input: InsertPendingExternalAccountInput) {
      const row = await db
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id,
             organization_id,
             project_id,
             counterparty_id,
             provider,
             provider_customer_reference,
             fiat_currency,
             destination_country,
             payment_rail
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          generateCounterpartyProviderAccountId(),
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider,
          input.providerCustomerReference,
          input.fiatCurrency,
          input.destinationCountry,
          input.paymentRail
        )
        .first<Record<string, unknown>>();

      if (row === null) {
        throw internalError("External provider-account reservation escaped its tenant scope.");
      }
      return counterpartyProviderAccountRowSchema.parse(row);
    },

    async completeExternalAccount(input: CompleteExternalAccountInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET external_account_reference = ?,
               provider_status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency IS NOT NULL
             AND status = 'active'
           RETURNING *`
        )
        .bind(
          input.externalAccountReference,
          input.providerStatus,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : counterpartyProviderAccountRowSchema.parse(row);
    },

    async updateExternalAccountStatus(input: UpdateExternalAccountStatusInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET provider_status = ?,
               payment_rail = COALESCE(?, payment_rail),
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency IS NOT NULL
             AND status = 'active'
           RETURNING *`
        )
        .bind(
          input.providerStatus,
          input.paymentRail === undefined ? null : input.paymentRail,
          input.id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.provider
        )
        .first<Record<string, unknown>>();

      return row === null ? null : counterpartyProviderAccountRowSchema.parse(row);
    },

    async archiveExternalAccount(input: ArchiveExternalAccountInput) {
      const row = await db
        .prepare(
          `UPDATE counterparty_provider_accounts
           SET status = 'archived',
               updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND counterparty_id = ?
             AND provider = ?
             AND fiat_currency IS NOT NULL
             AND status = 'active'
           RETURNING *`
        )
        .bind(input.id, input.organizationId, input.projectId, input.counterpartyId, input.provider)
        .first<Record<string, unknown>>();

      return row === null ? null : counterpartyProviderAccountRowSchema.parse(row);
    },
  };
}
