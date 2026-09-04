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

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Counterparty account ${field} is missing`);
  }
  return value;
}

/**
 * Extracts the denormalized crypto-wallet lookup columns from account details.
 *
 * @param details - The account details JSON.
 * @returns The network and address values, or null when absent.
 */
function cryptoAccountLookup(details: Record<string, unknown>): {
  network: string | null;
  address: string | null;
} {
  return {
    network: typeof details.network === "string" ? details.network : null,
    address: typeof details.address === "string" ? details.address : null,
  };
}

function mapCounterpartyAccountRow(row: Record<string, unknown>): CounterpartyAccountRow {
  return {
    id: assertString(row.id, "id"),
    organization_id: assertString(row.organization_id, "organization_id"),
    project_id: assertString(row.project_id, "project_id"),
    counterparty_id: assertString(row.counterparty_id, "counterparty_id"),
    account_kind: row.account_kind as CounterpartyAccountKind,
    label: (row.label as string | null) ?? null,
    details: row.details as CounterpartyAccountDetails,
    provider_account_data: row.provider_account_data as CounterpartyAccountProviderData,
    status: row.status as CounterpartyAccountStatus,
    created_at: assertString(row.created_at, "created_at"),
    updated_at: assertString(row.updated_at, "updated_at"),
  };
}

export function createPostgresCounterpartyAccountsRepository(
  db: AppDb
): CounterpartyAccountsRepository {
  return {
    async createCounterpartyAccount(input: CreateCounterpartyAccountInput) {
      const id = generateCounterpartyAccountId();
      const label = input.label ?? null;
      const details = input.details ?? {};
      const providerAccountData = input.providerAccountData ?? {};
      const lookup = cryptoAccountLookup(details);

      const row = await db
        .prepare(
          `INSERT INTO counterparty_accounts (
             id, organization_id, project_id, counterparty_id, account_kind,
             label, details, provider_account_data, network, address
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.accountKind,
          label,
          details,
          providerAccountData,
          lookup.network,
          lookup.address
        )
        .first<Record<string, unknown>>();

      return row ? mapCounterpartyAccountRow(row) : null;
    },

    async updateCounterpartyAccount(input: UpdateCounterpartyAccountInput) {
      return db.transaction(async (tx) => {
        const row = await tx
          .prepare(
            `SELECT * FROM counterparty_accounts
              WHERE counterparty_id = ?
                AND id = ?
                AND organization_id = ?
                AND project_id = ?
                AND status = 'active'
              FOR UPDATE`
          )
          .bind(
            input.counterpartyId,
            input.counterpartyAccountId,
            input.organizationId,
            input.projectId
          )
          .first<Record<string, unknown>>();
        if (!row) {
          return null;
        }
        const current = mapCounterpartyAccountRow(row);
        const label = input.label !== undefined ? input.label : current.label;
        const details = input.details ?? current.details;
        const providerAccountData = input.providerAccountData ?? current.provider_account_data;
        const lookup = cryptoAccountLookup(details);

        const updated = await tx
          .prepare(
            `UPDATE counterparty_accounts
                SET label = ?,
                    details = ?,
                    provider_account_data = ?,
                    network = ?,
                    address = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ?
            RETURNING *`
          )
          .bind(label, details, providerAccountData, lookup.network, lookup.address, current.id)
          .first<Record<string, unknown>>();

        return updated ? mapCounterpartyAccountRow(updated) : null;
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
      return result.results.map((row) => mapCounterpartyAccountRow(row));
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
        rows: rowsResult.results.map((row) => mapCounterpartyAccountRow(row)),
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
              AND COALESCE(a.network, a.details->>'network') = 'solana'
              AND COALESCE(a.address, a.details->>'address') IS NOT NULL
              AND (?::text IS NULL OR c.display_name ILIKE ?)
              ${idClause}`;

      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT a.*, c.display_name AS counterparty_display_name
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

      const rows = rowsResult.results.map((row) => {
        const account = mapCounterpartyAccountRow(row);
        const address =
          typeof row.address === "string" ? row.address : (account.details.address as string);
        return {
          counterparty_id: account.counterparty_id,
          counterparty_display_name: row.counterparty_display_name as string,
          account_id: account.id,
          account_label: account.label,
          address,
        };
      });
      return { rows, total: countRow?.total ?? 0 };
    },
  };
}
