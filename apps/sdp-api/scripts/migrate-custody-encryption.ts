import { closeDatabasePools, getDb } from "../src/db";
import { getProcessEnv } from "../src/lib/runtime-env";
import { createCustodyCipher } from "../src/services/custody-cipher/cipher-router";
import type { Env } from "../src/types/env";

const BATCH_SIZE = 50;

// SCHEMA GAP — provider_credentials.encrypted_secret_payload backfill:
//
// The provider_credentials table (migration 0023) stores encrypted payloads in
// the encrypted_secret_payload column, but no production service currently
// persists rows to that table. There is also no encryption_version column, so
// distinguishing legacy ciphertext from v2 envelopes (which carry a "v2."
// prefix) would have to rely on the prefix alone. Because no code path writes
// to provider_credentials.encrypted_secret_payload yet, this backfill loop
// cannot be implemented safely without confirming (a) which service will start
// writing those rows and (b) whether an encryption_version column should be
// added before the backfill runs. Add the loop here once that schema is stable.

async function migrateCustodyConfigs(env: Env): Promise<number> {
  const db = getDb(env);
  const cipher = createCustodyCipher(env);
  let total = 0;

  while (true) {
    const { results } = await db
      .prepare(
        `SELECT id, organization_id, config_encrypted
         FROM custody_configs
         WHERE encryption_version = 'sdp-custody-encryption-v1'
         ORDER BY id
         LIMIT ${BATCH_SIZE}`
      )
      .all<{ id: string; organization_id: string; config_encrypted: string }>();

    if (results.length === 0) {
      break;
    }

    for (const row of results) {
      const plaintext = await cipher.decrypt(row.organization_id, row.config_encrypted);
      const reEncrypted = await cipher.encrypt(row.organization_id, plaintext);

      const updated = await db
        .prepare(
          `UPDATE custody_configs
           SET config_encrypted = ?,
               encryption_version = 'sdp-custody-kms-v2',
               updated_at = datetime('now')
           WHERE id = ?
             AND encryption_version = 'sdp-custody-encryption-v1'
             AND config_encrypted = ?`
        )
        .bind(reEncrypted, row.id, row.config_encrypted)
        .run();

      if (updated > 0) {
        total += 1;
        console.info(`[custody_configs] migrated ${total} rows (last id: ${row.id})`);
      }
    }
  }

  return total;
}

async function main(): Promise<void> {
  const env = getProcessEnv();

  if (!env.CUSTODY_ENCRYPTION_KEY) {
    throw new Error("CUSTODY_ENCRYPTION_KEY must be set (legacy key for decryption)");
  }
  if (!env.CUSTODY_KMS_KEY_NAME) {
    throw new Error("CUSTODY_KMS_KEY_NAME must be set (v2 KMS key for re-encryption)");
  }

  try {
    const migrated = await migrateCustodyConfigs(env);
    console.info(`Done. Migrated ${migrated} custody_configs rows.`);
  } finally {
    await closeDatabasePools();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
