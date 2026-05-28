import type {
  CounterpartyAccountDetails,
  CounterpartyAccountKind,
  CounterpartyAccountProviderData,
  CounterpartyAccountStatus,
} from "@sdp/types";
import type { AppDb } from "@/db";
import type {
  ArchiveCounterpartyAccountInput,
  CounterpartyAccountRow,
  CounterpartyAccountsRepository,
  CreateCounterpartyAccountInput,
  ListCounterpartyAccountsByCounterpartyInput,
  ListCounterpartyAccountsResult,
  UpdateCounterpartyAccountInput,
} from "./counterparty-account.repository";
import { generateCounterpartyAccountId } from "./counterparty-account.repository";

function mapCounterpartyAccountRow(row: Record<string, unknown>): CounterpartyAccountRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    counterparty_id: row.counterparty_id as string,
    account_kind: row.account_kind as CounterpartyAccountKind,
    label: (row.label as string | null) ?? null,
    details: row.details as CounterpartyAccountDetails,
    provider_account_data: row.provider_account_data as CounterpartyAccountProviderData,
    status: row.status as CounterpartyAccountStatus,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getCounterpartyAccountByIdInternal(
  db: AppDb,
  params: { counterpartyAccountId: string; organizationId: string; projectId: string }
): Promise<CounterpartyAccountRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM counterparty_accounts
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?`
    )
    .bind(params.counterpartyAccountId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();
  return row ? mapCounterpartyAccountRow(row) : null;
}

export function createPostgresCounterpartyAccountsRepository(
  db: AppDb
): CounterpartyAccountsRepository {
  return {
    async createCounterpartyAccount(input: CreateCounterpartyAccountInput) {
      const id = generateCounterpartyAccountId();

      await db
        .prepare(
          `INSERT INTO counterparty_accounts (
             id,
             organization_id,
             project_id,
             counterparty_id,
             account_kind,
             label,
             details,
             provider_account_data
           ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, '{}'::jsonb), COALESCE(?, '{}'::jsonb))`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.accountKind,
          input.label ?? null,
          input.details ?? null,
          input.providerAccountData ?? null
        )
        .run();

      return getCounterpartyAccountByIdInternal(db, {
        counterpartyAccountId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateCounterpartyAccount(input: UpdateCounterpartyAccountInput) {
      const rowsAffected = await db
        .prepare(
          `UPDATE counterparty_accounts
             SET label = CASE WHEN ?::boolean THEN ? ELSE label END,
                 details = COALESCE(?, details),
                 provider_account_data = COALESCE(?, provider_account_data),
                 updated_at = sdp_iso_now()
           WHERE counterparty_id = ?
             AND id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(
          input.label !== undefined,
          input.label ?? null,
          input.details ?? null,
          input.providerAccountData ?? null,
          input.counterpartyId,
          input.counterpartyAccountId,
          input.organizationId,
          input.projectId
        )
        .run();

      if (rowsAffected === 0) {
        return null;
      }

      return getCounterpartyAccountByIdInternal(db, {
        counterpartyAccountId: input.counterpartyAccountId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async archiveCounterpartyAccount(input: ArchiveCounterpartyAccountInput) {
      const result = await db
        .prepare(
          `UPDATE counterparty_accounts
             SET status = 'archived',
                 updated_at = sdp_iso_now()
           WHERE counterparty_id = ?
             AND id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'`
        )
        .bind(
          input.counterpartyId,
          input.counterpartyAccountId,
          input.organizationId,
          input.projectId
        )
        .run();

      if (result === 0) {
        return null;
      }

      return getCounterpartyAccountByIdInternal(db, {
        counterpartyAccountId: input.counterpartyAccountId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async getCounterpartyAccountById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_accounts
             WHERE counterparty_id = ?
               AND id = ?
               AND organization_id = ?
               AND project_id = ?
               AND status = 'active'`
        )
        .bind(
          params.counterpartyId,
          params.counterpartyAccountId,
          params.organizationId,
          params.projectId
        )
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyAccountRow(row) : null;
    },

    async listCounterpartyAccountsByCounterparty(
      params: ListCounterpartyAccountsByCounterpartyInput
    ): Promise<ListCounterpartyAccountsResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM counterparty_accounts
              WHERE counterparty_id = ?
                AND organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
                AND (?::text IS NULL OR account_kind = ?::text)
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.counterpartyId,
            params.organizationId,
            params.projectId,
            params.includeArchived ?? false,
            params.accountKind ?? null,
            params.accountKind ?? null,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM counterparty_accounts
              WHERE counterparty_id = ?
                AND organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
                AND (?::text IS NULL OR account_kind = ?::text)`
          )
          .bind(
            params.counterpartyId,
            params.organizationId,
            params.projectId,
            params.includeArchived ?? false,
            params.accountKind ?? null,
            params.accountKind ?? null
          )
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map(mapCounterpartyAccountRow),
        total: countRow?.total ?? 0,
      };
    },
  };
}
