import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import {
  acquireCounterpartyPiiWriteLock,
  getCounterpartyPiiMigrationPhase,
} from "@/db/repositories/counterparty-pii.repository";
import type { PiiCipher } from "@/services/pii-cipher/pii-cipher";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import {
  backfillAccounts,
  backfillCounterparties,
  cutoverCounterpartyPii,
  purgeCounterpartyPii,
  restoreCounterpartyPiiPlaintext,
  verifyCounterpartyPii,
} from "../../scripts/counterparty-pii-migrate";

const PROJECT_ID = "prj_pii_migration";
const COUNTERPARTY_ID = "counterparty_pii_migration";
const ACCOUNT_ID = "counterparty_account_pii_migration";

describe("counterparty PII migration lifecycle", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM counterparty_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();
    await db
      .prepare(
        `UPDATE counterparty_pii_migration_state
            SET phase = 'dual_write',
                fallback_read_count = 0,
                last_fallback_read_at = NULL`
      )
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'PII migration', 'pii-migration', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, external_id, entity_type, display_name,
           email, identity, provider_data, status, created_by
         ) VALUES (?, ?, ?, 'opaque-reference', 'individual', 'Migration Recipient',
                   'legacy@example.com', ?, ?, 'active', ?)`
      )
      .bind(
        COUNTERPARTY_ID,
        TEST_ORG.id,
        PROJECT_ID,
        {
          firstName: "Legacy",
          lastName: "Recipient",
          dateOfBirth: "1990-01-01",
          phone: "+14155550123",
          address: { line1: "1 Main St", city: "San Francisco", countryCode: "US" },
        },
        {
          bvnk: { customer: { customerReference: "bvnk-customer-1" } },
          mural: { organization: { id: "mural-org-1" } },
        },
        TEST_USER.id
      )
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts (
           id, organization_id, project_id, counterparty_id, account_kind,
           label, details, provider_account_data, status
         ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Legacy account', ?, ?, 'active')`
      )
      .bind(
        ACCOUNT_ID,
        TEST_ORG.id,
        PROJECT_ID,
        COUNTERPARTY_ID,
        { network: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { providerReference: "provider-account-1" }
      )
      .run();
  });

  it("backfills, verifies, purges, and explicitly restores without changing API data", async () => {
    const db = getDb(env);
    const cipher = env.counterpartyPiiCipher;

    await expect(backfillCounterparties(db, cipher)).resolves.toBe(1);
    await expect(backfillAccounts(db, cipher)).resolves.toBe(1);
    await expect(backfillCounterparties(db, cipher)).resolves.toBe(0);
    await expect(backfillAccounts(db, cipher)).resolves.toBe(0);
    await expect(verifyCounterpartyPii(db, cipher)).resolves.toBeUndefined();

    const encrypted = await db
      .prepare(
        `SELECT pii_encrypted, provider_data_encrypted,
                bvnk_customer_reference, mural_organization_id
           FROM counterparties
          WHERE id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .first<Record<string, unknown>>();
    expect(encrypted?.pii_encrypted).toMatch(/^pii-local-v1\./);
    expect(encrypted?.provider_data_encrypted).toMatch(/^pii-local-v1\./);
    expect(encrypted?.bvnk_customer_reference).toBe("bvnk-customer-1");
    expect(encrypted?.mural_organization_id).toBe("mural-org-1");

    await cutoverCounterpartyPii(db, cipher);
    await expect(purgeCounterpartyPii(db, cipher)).resolves.toBeUndefined();

    const purged = await db
      .prepare(
        `SELECT email, identity, provider_data
           FROM counterparties
          WHERE id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .first<Record<string, unknown>>();
    expect(purged).toEqual({ email: null, identity: null, provider_data: null });

    const repo = createPostgresCounterpartiesRepository(db, cipher);
    const readable = await repo.getCounterpartyById({
      counterpartyId: COUNTERPARTY_ID,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
    });
    expect(readable?.email).toBe("legacy@example.com");
    expect(readable?.identity).toMatchObject({ firstName: "Legacy" });
    expect(readable?.provider_data).toMatchObject({
      bvnk: { customer: { customerReference: "bvnk-customer-1" } },
    });

    process.argv.push("--confirm-security-regression");
    try {
      await expect(restoreCounterpartyPiiPlaintext(db, cipher)).resolves.toBeUndefined();
    } finally {
      process.argv.splice(process.argv.indexOf("--confirm-security-regression"), 1);
    }

    const restored = await db
      .prepare(
        `SELECT email, identity, provider_data
           FROM counterparties
          WHERE id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .first<Record<string, unknown>>();
    expect(restored?.email).toBe("legacy@example.com");
    expect(restored?.identity).toMatchObject({ firstName: "Legacy" });
    expect(restored?.provider_data).toMatchObject({
      mural: { organization: { id: "mural-org-1" } },
    });
  });

  it("refuses to purge before encrypted-only cutover", async () => {
    const db = getDb(env);
    const cipher = env.counterpartyPiiCipher;
    await backfillCounterparties(db, cipher);
    await backfillAccounts(db, cipher);

    await expect(purgeCounterpartyPii(db, cipher)).rejects.toThrow(/cut over/i);
  });

  it("serializes concurrent encrypted provider-data mutations without losing either update", async () => {
    const db = getDb(env);
    const cipher = env.counterpartyPiiCipher;
    await backfillCounterparties(db, cipher);
    const repo = createPostgresCounterpartiesRepository(db, cipher);
    const scope = {
      counterpartyId: COUNTERPARTY_ID,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
    };

    await Promise.all([
      repo.mutateProviderData({
        ...scope,
        mutate: (current) => ({ ...current, providerA: { status: "ready" } }),
      }),
      repo.mutateProviderData({
        ...scope,
        mutate: (current) => ({ ...current, providerB: { status: "active" } }),
      }),
    ]);

    const updated = await repo.getCounterpartyById(scope);
    expect(updated?.provider_data).toMatchObject({
      providerA: { status: "ready" },
      providerB: { status: "active" },
    });
  });

  it("waits for an in-flight live-write lock before committing cutover", async () => {
    const db = getDb(env);
    const cipher = env.counterpartyPiiCipher;
    await backfillCounterparties(db, cipher);
    await backfillAccounts(db, cipher);

    let releaseWrite: () => void = () => {};
    const writeMayFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeLocked: () => void = () => {};
    const writeHasLock = new Promise<void>((resolve) => {
      writeLocked = resolve;
    });
    const liveWrite = db.transaction(async (tx) => {
      await acquireCounterpartyPiiWriteLock(tx);
      writeLocked();
      await writeMayFinish;
    });
    await writeHasLock;

    let cutoverFinished = false;
    const cutover = cutoverCounterpartyPii(db, cipher).then(() => {
      cutoverFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cutoverFinished).toBe(false);

    releaseWrite();
    await Promise.all([liveWrite, cutover]);
    await expect(getCounterpartyPiiMigrationPhase(db)).resolves.toBe("encrypted_only");
  });

  it("blocks live updates until emergency plaintext restoration is complete", async () => {
    const db = getDb(env);
    const cipher = env.counterpartyPiiCipher;
    await backfillCounterparties(db, cipher);
    await backfillAccounts(db, cipher);
    await cutoverCounterpartyPii(db, cipher);
    await purgeCounterpartyPii(db, cipher);

    let allowDecrypt: () => void = () => {};
    const decryptMayFinish = new Promise<void>((resolve) => {
      allowDecrypt = resolve;
    });
    let decryptStarted: () => void = () => {};
    const restoreHasLock = new Promise<void>((resolve) => {
      decryptStarted = resolve;
    });
    let firstDecrypt = true;
    const blockingCipher: PiiCipher = {
      encrypt: (context, plaintext) => cipher.encrypt(context, plaintext),
      async decrypt(context, ciphertext) {
        if (firstDecrypt) {
          firstDecrypt = false;
          decryptStarted();
          await decryptMayFinish;
        }
        return cipher.decrypt(context, ciphertext);
      },
    };

    process.argv.push("--confirm-security-regression");
    try {
      const restore = restoreCounterpartyPiiPlaintext(db, blockingCipher);
      await restoreHasLock;

      const repo = createPostgresCounterpartiesRepository(db, cipher);
      let updateFinished = false;
      const update = repo
        .updateCounterparty({
          counterpartyId: COUNTERPARTY_ID,
          organizationId: TEST_ORG.id,
          projectId: PROJECT_ID,
          email: "updated-after-restore@example.com",
        })
        .then(() => {
          updateFinished = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(updateFinished).toBe(false);

      allowDecrypt();
      await Promise.all([restore, update]);
    } finally {
      const confirmationIndex = process.argv.indexOf("--confirm-security-regression");
      if (confirmationIndex >= 0) {
        process.argv.splice(confirmationIndex, 1);
      }
    }

    await expect(getCounterpartyPiiMigrationPhase(db)).resolves.toBe("dual_write");
    const legacy = await db
      .prepare("SELECT email FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{ email: string | null }>();
    expect(legacy?.email).toBe("updated-after-restore@example.com");
  });
});
