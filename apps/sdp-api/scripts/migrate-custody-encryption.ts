import { closeDatabasePools, getDb } from "../src/db";
import { getProcessEnv } from "../src/lib/runtime-env";
import { createCustodyCipher } from "../src/services/custody-cipher/cipher-router";
import { migrateNestedCustodySecrets } from "../src/services/custody-cipher/nested-secret-migration";
import type { Env } from "../src/types/env";

const BATCH_SIZE = 50;
const LEGACY_VERSION = "sdp-custody-encryption-v1";
const V2_VERSION = "sdp-custody-kms-v2";

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

interface CustodyConfigRow {
  id: string;
  organization_id: string;
  config_encrypted: string;
}

interface PassCounters {
  migrated: number;
  contested: number;
  failed: number;
}

const MAX_SCANS = 10;

async function migratePass(env: Env, version: string, label: string): Promise<PassCounters> {
  const counters: PassCounters = { migrated: 0, contested: 0, failed: 0 };

  for (let scan = 0; scan < MAX_SCANS; scan++) {
    const pass = await scanOnce(env, version, label);
    counters.migrated += pass.migrated;
    counters.contested += pass.contested;
    counters.failed += pass.failed;
    if (pass.migrated === 0 && pass.contested === 0) {
      return counters;
    }
  }

  console.warn(`[${label}] rows still migrating after ${MAX_SCANS} scans; rerun to converge`);
  counters.contested += 1;
  return counters;
}

async function scanOnce(env: Env, version: string, label: string): Promise<PassCounters> {
  const db = getDb(env);
  const cipher = createCustodyCipher(env);
  const counters: PassCounters = { migrated: 0, contested: 0, failed: 0 };
  let lastId = "";

  while (true) {
    const { results } = await db
      .prepare(
        `SELECT id, organization_id, config_encrypted
         FROM custody_configs
         WHERE encryption_version = ?
           AND id > ?
         ORDER BY id
         LIMIT ${BATCH_SIZE}`
      )
      .bind(version, lastId)
      .all<CustodyConfigRow>();

    if (results.length === 0) {
      break;
    }

    for (const row of results) {
      lastId = row.id;

      try {
        const plaintext = await cipher.decrypt(row.organization_id, row.config_encrypted);
        const nested = await migrateNestedCustodySecrets(cipher, row.organization_id, plaintext);
        if (version === V2_VERSION && !nested.changed) {
          continue;
        }
        const reEncrypted = await cipher.encrypt(row.organization_id, nested.configJson);

        const roundTrip = await cipher.decrypt(row.organization_id, reEncrypted);
        if (roundTrip !== nested.configJson) {
          counters.failed += 1;
          console.error(`[${label}] row ${row.id} failed round-trip verification, not written`);
          continue;
        }

        const updated = await db
          .prepare(
            `UPDATE custody_configs
             SET config_encrypted = ?,
                 encryption_version = '${V2_VERSION}',
                 updated_at = datetime('now')
             WHERE id = ?
               AND config_encrypted = ?`
          )
          .bind(reEncrypted, row.id, row.config_encrypted)
          .run();

        if (updated > 0) {
          counters.migrated += 1;
          console.info(`[${label}] migrated ${counters.migrated} rows (last id: ${row.id})`);
        } else {
          counters.contested += 1;
          console.warn(`[${label}] row ${row.id} changed concurrently, skipped; rerun to verify`);
        }
      } catch (e: unknown) {
        counters.failed += 1;
        console.error(`[${label}] row ${row.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  return counters;
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
    const nested = await migratePass(env, V2_VERSION, "custody_configs:nested");
    const legacy = await migratePass(env, LEGACY_VERSION, "custody_configs");

    const { results } = await getDb(env)
      .prepare(`SELECT COUNT(*) AS n FROM custody_configs WHERE encryption_version = ?`)
      .bind(LEGACY_VERSION)
      .all<{ n: number }>();
    const remaining = results[0]?.n ?? 0;
    if (remaining > 0) {
      console.error(`${remaining} legacy rows appeared after the final scan; rerun.`);
      process.exitCode = 1;
    }

    const contested = legacy.contested + nested.contested;
    const failed = legacy.failed + nested.failed;
    if (contested > 0 || failed > 0) {
      console.error(
        `Migrated ${legacy.migrated} legacy rows, ${nested.migrated} nested-secret rows; ` +
          `${failed} rows failed, ${contested} contested. Rerun until both reach zero.`
      );
      process.exitCode = 1;
    } else if (remaining === 0) {
      console.info(
        `Done. Migrated ${legacy.migrated} legacy rows, ${nested.migrated} nested-secret rows.`
      );
    }
  } finally {
    await closeDatabasePools();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
