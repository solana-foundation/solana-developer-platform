import { pathToFileURL } from "node:url";
import type {
  CounterpartyAccountDetails,
  CounterpartyAccountProviderData,
  CounterpartyIdentity,
  CounterpartyProviderData,
} from "@sdp/types";
import { closeDatabasePools, type DatabaseExecutor, getDb } from "../src/db";
import {
  COUNTERPARTY_PII_MIGRATION_ID,
  cryptoAccountLookup,
  providerLookupReferences,
} from "../src/db/repositories/counterparty-pii.repository";
import { getProcessEnv } from "../src/lib/runtime-env";
import {
  createPiiCipher,
  type PiiCipher,
  type PiiCipherContext,
} from "../src/services/pii-cipher/pii-cipher";
import type { Env } from "../src/types/env";

const BATCH_SIZE = 50;
const CONCURRENCY = 5;

type Phase = "backfill" | "verify" | "cutover" | "purge" | "restore-plaintext";

interface CounterpartyStorageRow {
  id: string;
  organization_id: string;
  project_id: string;
  email: string | null;
  identity: CounterpartyIdentity | null;
  provider_data: CounterpartyProviderData | null;
  pii_encrypted: string | null;
  provider_data_encrypted: string | null;
  bvnk_customer_reference: string | null;
  mural_organization_id: string | null;
}

interface AccountStorageRow {
  id: string;
  organization_id: string;
  project_id: string;
  label: string | null;
  details: CounterpartyAccountDetails | null;
  provider_account_data: CounterpartyAccountProviderData | null;
  sensitive_data_encrypted: string | null;
  network: string | null;
  address: string | null;
}

function context(
  row: { id: string; organization_id: string; project_id: string },
  resourceType: "counterparty" | "counterparty_account",
  field: "identity" | "provider_data" | "account_data"
): PiiCipherContext {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    resourceType,
    resourceId: row.id,
    field,
  };
}

function parseObject<T extends object>(plaintext: string, field: string): T {
  const value: unknown = JSON.parse(plaintext);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} ciphertext does not contain an object`);
  }
  return value as T;
}

async function mapLimit<T>(values: readonly T[], callback: (value: T) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      await callback(values[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, () => worker()));
}

export async function backfillCounterparties(
  db: DatabaseExecutor,
  cipher: PiiCipher
): Promise<number> {
  let total = 0;
  while (true) {
    const rows = await db.queryMany<CounterpartyStorageRow>(
      `SELECT id, organization_id, project_id, email, identity, provider_data,
              pii_encrypted, provider_data_encrypted,
              bvnk_customer_reference, mural_organization_id
         FROM counterparties
        WHERE pii_encrypted IS NULL
           OR provider_data_encrypted IS NULL
           OR (
             bvnk_customer_reference IS NULL
             AND provider_data->'bvnk'->'customer'->>'customerReference' IS NOT NULL
           )
           OR (
             mural_organization_id IS NULL
             AND provider_data->'mural'->'organization'->>'id' IS NOT NULL
           )
        ORDER BY id
        LIMIT ${BATCH_SIZE}`
    );
    if (rows.length === 0) {
      return total;
    }

    await mapLimit(rows, async (row) => {
      if (!row.project_id) {
        throw new Error("Cannot encrypt a counterparty without project_id");
      }
      const providerData = row.provider_data ?? {};
      const piiEncrypted =
        row.pii_encrypted ??
        (await cipher.encrypt(
          context(row, "counterparty", "identity"),
          JSON.stringify({
            email: row.email,
            identity: row.identity,
          })
        ));
      if (row.email === null || row.identity === null) {
        if (row.pii_encrypted === null) {
          throw new Error("Legacy counterparty PII is missing before backfill");
        }
      }
      const providerDataEncrypted =
        row.provider_data_encrypted ??
        (await cipher.encrypt(
          context(row, "counterparty", "provider_data"),
          JSON.stringify(providerData)
        ));
      const refs = providerLookupReferences(providerData);
      const updated = await db.execute(
        `UPDATE counterparties
            SET pii_encrypted = COALESCE(pii_encrypted, ?),
                provider_data_encrypted = COALESCE(provider_data_encrypted, ?),
                bvnk_customer_reference = COALESCE(bvnk_customer_reference, ?),
                mural_organization_id = COALESCE(mural_organization_id, ?)
          WHERE id = ?
            AND (
              pii_encrypted IS NULL
              OR provider_data_encrypted IS NULL
              OR (
                bvnk_customer_reference IS NULL
                AND provider_data->'bvnk'->'customer'->>'customerReference' IS NOT NULL
              )
              OR (
                mural_organization_id IS NULL
                AND provider_data->'mural'->'organization'->>'id' IS NOT NULL
              )
            )`,
        [
          piiEncrypted,
          providerDataEncrypted,
          refs.bvnkCustomerReference,
          refs.muralOrganizationId,
          row.id,
        ]
      );
      total += updated;
    });
    console.info(JSON.stringify({ phase: "backfill", resource: "counterparty", processed: total }));
  }
}

export async function backfillAccounts(db: DatabaseExecutor, cipher: PiiCipher): Promise<number> {
  let total = 0;
  while (true) {
    const rows = await db.queryMany<AccountStorageRow>(
      `SELECT id, organization_id, project_id, label, details, provider_account_data,
              sensitive_data_encrypted, network, address
         FROM counterparty_accounts
        WHERE sensitive_data_encrypted IS NULL
           OR (
             account_kind = 'crypto_wallet'
             AND (
               (network IS NULL AND details->>'network' IS NOT NULL)
               OR (address IS NULL AND details->>'address' IS NOT NULL)
             )
           )
        ORDER BY id
        LIMIT ${BATCH_SIZE}`
    );
    if (rows.length === 0) {
      return total;
    }

    await mapLimit(rows, async (row) => {
      if (!row.project_id) {
        throw new Error("Cannot encrypt a counterparty account without project_id");
      }
      if (row.sensitive_data_encrypted === null && row.details === null) {
        throw new Error("Legacy counterparty account data is missing before backfill");
      }
      const details = row.details ?? {};
      const providerAccountData = row.provider_account_data ?? {};
      const encrypted =
        row.sensitive_data_encrypted ??
        (await cipher.encrypt(
          context(row, "counterparty_account", "account_data"),
          JSON.stringify({
            label: row.label,
            details,
            providerAccountData,
          })
        ));
      const lookup = cryptoAccountLookup(details);
      const updated = await db.execute(
        `UPDATE counterparty_accounts
            SET sensitive_data_encrypted = COALESCE(sensitive_data_encrypted, ?),
                network = COALESCE(network, ?),
                address = COALESCE(address, ?)
          WHERE id = ?
            AND (
              sensitive_data_encrypted IS NULL
              OR (
                account_kind = 'crypto_wallet'
                AND (
                  (network IS NULL AND details->>'network' IS NOT NULL)
                  OR (address IS NULL AND details->>'address' IS NOT NULL)
                )
              )
            )`,
        [encrypted, lookup.network, lookup.address, row.id]
      );
      total += updated;
    });
    console.info(JSON.stringify({ phase: "backfill", resource: "account", processed: total }));
  }
}

export async function verifyCounterpartyPii(
  db: DatabaseExecutor,
  cipher: PiiCipher
): Promise<void> {
  const missingCounterparties = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM counterparties
      WHERE pii_encrypted IS NULL OR provider_data_encrypted IS NULL`
  );
  const missingAccounts = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM counterparty_accounts
      WHERE sensitive_data_encrypted IS NULL`
  );
  if ((missingCounterparties?.count ?? 0) !== 0 || (missingAccounts?.count ?? 0) !== 0) {
    throw new Error("Counterparty PII backfill is incomplete");
  }

  let checkedCounterparties = 0;
  let counterpartyCursor = "";
  while (true) {
    const rows = await db.queryMany<CounterpartyStorageRow>(
      `SELECT id, organization_id, project_id, email, identity, provider_data,
              pii_encrypted, provider_data_encrypted,
              bvnk_customer_reference, mural_organization_id
         FROM counterparties
        WHERE id > ?
        ORDER BY id
        LIMIT ${BATCH_SIZE}`,
      [counterpartyCursor]
    );
    if (rows.length === 0) {
      break;
    }
    await mapLimit(rows, async (row) => {
      const pii = parseObject<{ email: string; identity: CounterpartyIdentity }>(
        await cipher.decrypt(context(row, "counterparty", "identity"), row.pii_encrypted as string),
        "counterparty PII"
      );
      if (typeof pii.email !== "string" || !pii.identity) {
        throw new Error("Counterparty PII ciphertext is incomplete");
      }
      const providerData = parseObject<CounterpartyProviderData>(
        await cipher.decrypt(
          context(row, "counterparty", "provider_data"),
          row.provider_data_encrypted as string
        ),
        "counterparty provider data"
      );
      const refs = providerLookupReferences(providerData);
      if (
        refs.bvnkCustomerReference !== row.bvnk_customer_reference ||
        refs.muralOrganizationId !== row.mural_organization_id
      ) {
        throw new Error("Counterparty provider lookup references do not match ciphertext");
      }
    });
    checkedCounterparties += rows.length;
    counterpartyCursor = rows.at(-1)?.id ?? counterpartyCursor;
  }

  let checkedAccounts = 0;
  let accountCursor = "";
  while (true) {
    const rows = await db.queryMany<AccountStorageRow>(
      `SELECT id, organization_id, project_id, label, details, provider_account_data,
              sensitive_data_encrypted, network, address
         FROM counterparty_accounts
        WHERE id > ?
        ORDER BY id
        LIMIT ${BATCH_SIZE}`,
      [accountCursor]
    );
    if (rows.length === 0) {
      break;
    }
    await mapLimit(rows, async (row) => {
      const payload = parseObject<{
        label: string | null;
        details: CounterpartyAccountDetails;
        providerAccountData: CounterpartyAccountProviderData;
      }>(
        await cipher.decrypt(
          context(row, "counterparty_account", "account_data"),
          row.sensitive_data_encrypted as string
        ),
        "counterparty account data"
      );
      const lookup = cryptoAccountLookup(payload.details);
      if (lookup.network !== row.network || lookup.address !== row.address) {
        throw new Error("Counterparty account lookup values do not match ciphertext");
      }
    });
    checkedAccounts += rows.length;
    accountCursor = rows.at(-1)?.id ?? accountCursor;
  }

  console.info(
    JSON.stringify({
      phase: "verify",
      checkedCounterparties,
      checkedAccounts,
      result: "ok",
    })
  );
}

export async function purgeCounterpartyPii(db: DatabaseExecutor, cipher: PiiCipher): Promise<void> {
  await verifyCounterpartyPii(db, cipher);
  const state = await db.queryOne<{ phase: string; fallback_read_count: number }>(
    `SELECT phase, fallback_read_count
       FROM counterparty_pii_migration_state
      WHERE id = ?`,
    [COUNTERPARTY_PII_MIGRATION_ID]
  );
  if (state?.phase !== "encrypted_only") {
    throw new Error("Counterparty PII must be cut over before purge");
  }
  if (state.fallback_read_count !== 0) {
    throw new Error("Counterparty PII fallback reads occurred after cutover");
  }

  let counterparties = 0;
  while (true) {
    const purged = await db.execute(
      `UPDATE counterparties
          SET email = NULL, identity = NULL, provider_data = NULL
        WHERE id IN (
          SELECT id
            FROM counterparties
           WHERE email IS NOT NULL OR identity IS NOT NULL OR provider_data IS NOT NULL
           ORDER BY id
           LIMIT ${BATCH_SIZE}
        )`
    );
    counterparties += purged;
    if (purged === 0) {
      break;
    }
  }

  let accounts = 0;
  while (true) {
    const purged = await db.execute(
      `UPDATE counterparty_accounts
          SET label = NULL, details = NULL, provider_account_data = NULL
        WHERE id IN (
          SELECT id
            FROM counterparty_accounts
           WHERE label IS NOT NULL OR details IS NOT NULL OR provider_account_data IS NOT NULL
           ORDER BY id
           LIMIT ${BATCH_SIZE}
        )`
    );
    accounts += purged;
    if (purged === 0) {
      break;
    }
  }
  console.info(JSON.stringify({ phase: "purge", counterparties, accounts, result: "ok" }));
}

export async function restoreCounterpartyPiiPlaintext(
  db: DatabaseExecutor,
  cipher: PiiCipher
): Promise<void> {
  if (!process.argv.includes("--confirm-security-regression")) {
    throw new Error(
      "restore-plaintext requires --confirm-security-regression because it rematerializes PII"
    );
  }

  let restoredCounterparties = 0;
  let counterpartyCursor = "";
  while (true) {
    const rows = await db.queryMany<CounterpartyStorageRow>(
      `SELECT id, organization_id, project_id, email, identity, provider_data,
              pii_encrypted, provider_data_encrypted,
              bvnk_customer_reference, mural_organization_id
         FROM counterparties
        WHERE id > ?
        ORDER BY id
        LIMIT ${BATCH_SIZE}`,
      [counterpartyCursor]
    );
    if (rows.length === 0) {
      break;
    }
    await mapLimit(rows, async (row) => {
      if (!row.pii_encrypted || !row.provider_data_encrypted) {
        throw new Error("Cannot restore plaintext from an incomplete encrypted row");
      }
      const pii = parseObject<{ email: string; identity: CounterpartyIdentity }>(
        await cipher.decrypt(context(row, "counterparty", "identity"), row.pii_encrypted),
        "counterparty PII"
      );
      const providerData = parseObject<CounterpartyProviderData>(
        await cipher.decrypt(
          context(row, "counterparty", "provider_data"),
          row.provider_data_encrypted
        ),
        "counterparty provider data"
      );
      restoredCounterparties += await db.execute(
        `UPDATE counterparties
            SET email = ?, identity = ?, provider_data = ?
          WHERE id = ?`,
        [pii.email, pii.identity, providerData, row.id]
      );
    });
    counterpartyCursor = rows.at(-1)?.id ?? counterpartyCursor;
  }

  let restoredAccounts = 0;
  let accountCursor = "";
  while (true) {
    const rows = await db.queryMany<AccountStorageRow>(
      `SELECT id, organization_id, project_id, label, details, provider_account_data,
              sensitive_data_encrypted, network, address
         FROM counterparty_accounts
        WHERE id > ?
        ORDER BY id
        LIMIT ${BATCH_SIZE}`,
      [accountCursor]
    );
    if (rows.length === 0) {
      break;
    }
    await mapLimit(rows, async (row) => {
      if (!row.sensitive_data_encrypted) {
        throw new Error("Cannot restore plaintext from an incomplete encrypted account row");
      }
      const payload = parseObject<{
        label: string | null;
        details: CounterpartyAccountDetails;
        providerAccountData: CounterpartyAccountProviderData;
      }>(
        await cipher.decrypt(
          context(row, "counterparty_account", "account_data"),
          row.sensitive_data_encrypted
        ),
        "counterparty account data"
      );
      restoredAccounts += await db.execute(
        `UPDATE counterparty_accounts
            SET label = ?, details = ?, provider_account_data = ?
          WHERE id = ?`,
        [payload.label, payload.details, payload.providerAccountData, row.id]
      );
    });
    accountCursor = rows.at(-1)?.id ?? accountCursor;
  }

  await db.execute(
    `UPDATE counterparty_pii_migration_state
        SET phase = 'dual_write',
            fallback_read_count = 0,
            last_fallback_read_at = NULL,
            updated_at = sdp_iso_now()
      WHERE id = ?`,
    [COUNTERPARTY_PII_MIGRATION_ID]
  );
  console.info(
    JSON.stringify({
      phase: "restore-plaintext",
      counterparties: restoredCounterparties,
      accounts: restoredAccounts,
      result: "ok",
    })
  );
}

function requestedPhase(): Phase {
  const phase = process.argv[2] as Phase | undefined;
  if (
    phase !== "backfill" &&
    phase !== "verify" &&
    phase !== "cutover" &&
    phase !== "purge" &&
    phase !== "restore-plaintext"
  ) {
    throw new Error("Expected phase: backfill | verify | cutover | purge | restore-plaintext");
  }
  return phase;
}

async function main(env: Env): Promise<void> {
  const phase = requestedPhase();
  const db = getDb(env);
  const cipher = createPiiCipher(env);

  if (phase === "backfill") {
    const counterparties = await backfillCounterparties(db, cipher);
    const accounts = await backfillAccounts(db, cipher);
    console.info(JSON.stringify({ phase, counterparties, accounts, result: "ok" }));
    return;
  }
  if (phase === "verify") {
    await verifyCounterpartyPii(db, cipher);
    return;
  }
  if (phase === "cutover") {
    await verifyCounterpartyPii(db, cipher);
    await db.execute(
      `UPDATE counterparty_pii_migration_state
          SET phase = 'encrypted_only',
              fallback_read_count = 0,
              last_fallback_read_at = NULL,
              updated_at = sdp_iso_now()
        WHERE id = ?`,
      [COUNTERPARTY_PII_MIGRATION_ID]
    );
    console.info(JSON.stringify({ phase, result: "ok" }));
    return;
  }
  if (phase === "purge") {
    await purgeCounterpartyPii(db, cipher);
    return;
  }
  await restoreCounterpartyPiiPlaintext(db, cipher);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(getProcessEnv())
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          phase: process.argv[2] ?? "unknown",
          result: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        })
      );
      process.exitCode = 1;
    })
    .finally(closeDatabasePools);
}
