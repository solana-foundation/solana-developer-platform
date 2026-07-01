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
      const row = await db
        .prepare(
          `UPDATE counterparty_accounts
             SET status = 'archived',
                 updated_at = sdp_iso_now()
           WHERE counterparty_id = ?
             AND id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'
           RETURNING *`
        )
        .bind(
          input.counterpartyId,
          input.counterpartyAccountId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapCounterpartyAccountRow(row) : null;
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

    async getCounterpartyAccountByIdInProject(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparty_accounts
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND status = 'active'`
        )
        .bind(params.counterpartyAccountId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyAccountRow(row) : null;
    },

    async listCounterpartyAccountsByIdsInProject(params) {
      if (params.counterpartyAccountIds.length === 0) {
        return [];
      }
      const placeholders = params.counterpartyAccountIds.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT * FROM counterparty_accounts
             WHERE id IN (${placeholders})
               AND organization_id = ?
               AND project_id = ?
               AND status = 'active'`
        )
        .bind(...params.counterpartyAccountIds, params.organizationId, params.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapCounterpartyAccountRow);
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

    async listBatchRecipients(params) {
      const searchLike = params.search ? `%${params.search}%` : null;
      const idValues = params.accountIds && params.accountIds.length > 0 ? params.accountIds : [];
      const idClause =
        idValues.length > 0 ? `AND a.id IN (${idValues.map(() => "?").join(", ")})` : "";
      const filter = `FROM counterparty_accounts a
             JOIN counterparties c
               ON c.id = a.counterparty_id
              AND c.organization_id = a.organization_id
              AND c.project_id = a.project_id
            WHERE a.organization_id = ?
              AND a.project_id = ?
              AND a.status = 'active'
              AND a.account_kind = 'crypto_wallet'
              AND c.status = 'active'
              AND a.details->>'network' = 'solana'
              AND a.details->>'address' IS NOT NULL
              AND (?::text IS NULL OR c.display_name ILIKE ?)
              ${idClause}`;

      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT a.counterparty_id,
                    c.display_name AS counterparty_display_name,
                    a.id AS account_id,
                    a.label AS account_label,
                    a.details->>'address' AS address
               ${filter}
            ORDER BY c.display_name ASC, a.created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.search ?? null,
            searchLike,
            ...idValues,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(`SELECT COUNT(*)::int AS total ${filter}`)
          .bind(
            params.organizationId,
            params.projectId,
            params.search ?? null,
            searchLike,
            ...idValues
          )
          .first<{ total: number }>(),
      ]);

      return {
        rows: rowsResult.results.map((row) => ({
          counterparty_id: row.counterparty_id as string,
          counterparty_display_name: row.counterparty_display_name as string,
          account_id: row.account_id as string,
          account_label: (row.account_label as string | null) ?? null,
          address: row.address as string,
        })),
        total: countRow?.total ?? 0,
      };
    },
  };
}
