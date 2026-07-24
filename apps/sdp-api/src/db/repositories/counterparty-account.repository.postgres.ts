import type {
  CounterpartyAccountDetails,
  CounterpartyAccountKind,
  CounterpartyAccountProviderData,
  CounterpartyAccountStatus,
} from "@sdp/types";
import type { AppDb, DatabaseExecutor } from "@/db";
import type { PiiCipher, PiiCipherContext } from "@/services/pii-cipher/pii-cipher";
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
import {
  cryptoAccountLookup,
  getCounterpartyPiiMigrationPhase,
  recordCounterpartyPiiFallbackRead,
} from "./counterparty-pii.repository";

interface CounterpartyAccountPiiPayload {
  label: string | null;
  details: CounterpartyAccountDetails;
  providerAccountData: CounterpartyAccountProviderData;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Counterparty account ${field} is missing`);
  }
  return value;
}

function accountContext(row: Record<string, unknown>): PiiCipherContext {
  return {
    organizationId: assertString(row.organization_id, "organization_id"),
    projectId: assertString(row.project_id, "project_id"),
    resourceType: "counterparty_account",
    resourceId: assertString(row.id, "id"),
    field: "account_data",
  };
}

function parsePayload(value: string): CounterpartyAccountPiiPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Counterparty account ciphertext contains invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Counterparty account ciphertext must contain a JSON object");
  }
  return parsed as CounterpartyAccountPiiPayload;
}

async function mapCounterpartyAccountRow(
  db: DatabaseExecutor,
  cipher: PiiCipher,
  row: Record<string, unknown>
): Promise<CounterpartyAccountRow> {
  let payload: CounterpartyAccountPiiPayload;
  if (typeof row.sensitive_data_encrypted === "string") {
    payload = parsePayload(await cipher.decrypt(accountContext(row), row.sensitive_data_encrypted));
  } else {
    await recordCounterpartyPiiFallbackRead(db);
    payload = {
      label: (row.label as string | null) ?? null,
      details: (row.details as CounterpartyAccountDetails | null) ?? {},
      providerAccountData:
        (row.provider_account_data as CounterpartyAccountProviderData | null) ?? {},
    };
  }

  return {
    id: assertString(row.id, "id"),
    organization_id: assertString(row.organization_id, "organization_id"),
    project_id: assertString(row.project_id, "project_id"),
    counterparty_id: assertString(row.counterparty_id, "counterparty_id"),
    account_kind: row.account_kind as CounterpartyAccountKind,
    label: payload.label,
    details: payload.details,
    provider_account_data: payload.providerAccountData,
    status: row.status as CounterpartyAccountStatus,
    created_at: assertString(row.created_at, "created_at"),
    updated_at: assertString(row.updated_at, "updated_at"),
  };
}

function inputContext(input: {
  organizationId: string;
  projectId: string;
  counterpartyAccountId: string;
}): PiiCipherContext {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    resourceType: "counterparty_account",
    resourceId: input.counterpartyAccountId,
    field: "account_data",
  };
}

async function encryptAccountData(
  cipher: PiiCipher,
  input: {
    counterpartyAccountId: string;
    organizationId: string;
    projectId: string;
    label: string | null;
    details: CounterpartyAccountDetails;
    providerAccountData: CounterpartyAccountProviderData;
  }
): Promise<string> {
  return cipher.encrypt(
    inputContext(input),
    JSON.stringify({
      label: input.label,
      details: input.details,
      providerAccountData: input.providerAccountData,
    })
  );
}

async function getCounterpartyAccountByIdInternal(
  db: DatabaseExecutor,
  cipher: PiiCipher,
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
  return row ? mapCounterpartyAccountRow(db, cipher, row) : null;
}

export function createPostgresCounterpartyAccountsRepository(
  db: AppDb,
  cipher: PiiCipher
): CounterpartyAccountsRepository {
  return {
    async createCounterpartyAccount(input: CreateCounterpartyAccountInput) {
      const id = generateCounterpartyAccountId();
      const label = input.label ?? null;
      const details = input.details ?? {};
      const providerAccountData = input.providerAccountData ?? {};
      const encrypted = await encryptAccountData(cipher, {
        counterpartyAccountId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        label,
        details,
        providerAccountData,
      });
      const phase = await getCounterpartyPiiMigrationPhase(db);
      const lookup = cryptoAccountLookup(details);

      await db
        .prepare(
          `INSERT INTO counterparty_accounts (
             id, organization_id, project_id, counterparty_id, account_kind,
             label, details, provider_account_data, sensitive_data_encrypted,
             network, address
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.accountKind,
          phase === "dual_write" ? label : null,
          phase === "dual_write" ? details : null,
          phase === "dual_write" ? providerAccountData : null,
          encrypted,
          lookup.network,
          lookup.address
        )
        .run();

      return getCounterpartyAccountByIdInternal(db, cipher, {
        counterpartyAccountId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
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
        const current = await mapCounterpartyAccountRow(tx, cipher, row);
        const label = input.label !== undefined ? input.label : current.label;
        const details = input.details ?? current.details;
        const providerAccountData = input.providerAccountData ?? current.provider_account_data;
        const encrypted = await encryptAccountData(cipher, {
          counterpartyAccountId: current.id,
          organizationId: current.organization_id,
          projectId: current.project_id,
          label,
          details,
          providerAccountData,
        });
        const phase = await getCounterpartyPiiMigrationPhase(tx);
        const lookup = cryptoAccountLookup(details);

        await tx
          .prepare(
            `UPDATE counterparty_accounts
                SET label = ?,
                    details = ?,
                    provider_account_data = ?,
                    sensitive_data_encrypted = ?,
                    network = ?,
                    address = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ?`
          )
          .bind(
            phase === "dual_write" ? label : null,
            phase === "dual_write" ? details : null,
            phase === "dual_write" ? providerAccountData : null,
            encrypted,
            lookup.network,
            lookup.address,
            current.id
          )
          .run();

        return getCounterpartyAccountByIdInternal(tx, cipher, {
          counterpartyAccountId: current.id,
          organizationId: current.organization_id,
          projectId: current.project_id,
        });
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
      return row ? mapCounterpartyAccountRow(db, cipher, row) : null;
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
      return row ? mapCounterpartyAccountRow(db, cipher, row) : null;
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
      return row ? mapCounterpartyAccountRow(db, cipher, row) : null;
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
      return Promise.all(result.results.map((row) => mapCounterpartyAccountRow(db, cipher, row)));
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
        rows: await Promise.all(
          rowsResult.results.map((row) => mapCounterpartyAccountRow(db, cipher, row))
        ),
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

      const rows = await Promise.all(
        rowsResult.results.map(async (row) => {
          const account = await mapCounterpartyAccountRow(db, cipher, row);
          const address =
            typeof row.address === "string" ? row.address : (account.details.address as string);
          return {
            counterparty_id: account.counterparty_id,
            counterparty_display_name: row.counterparty_display_name as string,
            account_id: account.id,
            account_label: account.label,
            address,
          };
        })
      );
      return { rows, total: countRow?.total ?? 0 };
    },
  };
}
