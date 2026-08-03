import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_CUSTODY_CONFIG, TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const MIGRATION_FILE = "0047_fold_payment_wallet_policies.sql";
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations/postgres"
);
const FOLD_MIGRATION_SQL = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

const LEGACY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS payment_wallet_policies (
      id TEXT PRIMARY KEY,
      custody_wallet_id TEXT NOT NULL,
      policy_type TEXT NOT NULL,
      policy TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
      updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
      FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE CASCADE,
      UNIQUE (custody_wallet_id, policy_type)
  )
`;
const LEGACY_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_payment_wallet_policies_wallet ON payment_wallet_policies(custody_wallet_id)";

interface LegacyPolicyRow {
  id: string;
  custodyWalletId: string;
  policyType: "destination_allowlist" | "transfer_limits";
  policy: string;
}

interface WalletControlProfileRow {
  id: string;
  status: string;
  active_revision_id: string | null;
}

interface WalletControlProfileRevisionRow {
  id: string;
  profile_id: string;
  revision_number: number;
  rules: Record<string, unknown>[];
  default_action: string;
}

interface SeedProfileResult {
  profileId: string;
  revisionId: string;
}

/**
 * Resolves the Postgres connection string the Vitest global setup exported
 * for this test run.
 *
 * @returns The TEST_DATABASE_URL connection string.
 */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("Test environment requires TEST_DATABASE_URL.");
  }
  return url;
}

/**
 * Recreates the legacy payment_wallet_policies table and its index.
 *
 * The Vitest global setup applies every migration under
 * src/db/migrations/postgres, including 0047, to a fresh container before
 * any test file runs, so by the time this suite starts the legacy table is
 * already gone. This puts it back so each test can seed pre-fold rows and
 * then run the migration's own SQL directly against them, mirroring how
 * 0047 runs against a real database that still has the table.
 *
 * @returns Resolves once the table and its index exist.
 */
async function recreateLegacyPaymentWalletPoliciesTable(): Promise<void> {
  const db = getDb(env);
  await db.prepare(LEGACY_TABLE_SQL).run();
  await db.prepare(LEGACY_INDEX_SQL).run();
}

/**
 * Executes the 0047 migration's SQL body against the test database.
 *
 * 0047 is already recorded as applied in schema_migrations by the global
 * test setup, so this re-runs the file's statements through a dedicated pg
 * client (simple query protocol, multi-statement, wrapped in its own
 * transaction) instead of the migration runner's applyPostgresMigration,
 * which would try to re-insert the already-applied schema_migrations row
 * and fail.
 *
 * @returns Resolves once the migration body has committed.
 */
async function applyFoldMigrationSql(): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(FOLD_MIGRATION_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Seeds the organization, user, project, custody config, and custody
 * wallet fixtures every test in this suite needs, following the same
 * fixture-seeding pattern as policy.repository.test.ts.
 *
 * @returns Resolves once every fixture row exists.
 */
async function seedOrgProjectAndWallet(): Promise<void> {
  const db = getDb(env);

  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();

  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(TEST_USER.id, TEST_USER.email)
    .run();

  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(
      TEST_PROJECT.id,
      TEST_ORG.id,
      TEST_PROJECT.name,
      TEST_PROJECT.slug,
      TEST_PROJECT.environment,
      TEST_USER.id
    )
    .run();

  await db
    .prepare(
      `INSERT INTO custody_configs (
         id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status
       ) VALUES (?, ?, ?, 'local', 'encrypted', ?, 'active')`
    )
    .bind(TEST_CUSTODY_CONFIG.id, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET.walletId)
    .run();

  await db
    .prepare(
      `INSERT INTO custody_wallets (
         id, custody_config_id, wallet_id, public_key, label, purpose, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .bind(
      TEST_CUSTODY_WALLET.id,
      TEST_CUSTODY_CONFIG.id,
      TEST_CUSTODY_WALLET.walletId,
      TEST_CUSTODY_WALLET.publicKey,
      TEST_CUSTODY_WALLET.label,
      TEST_CUSTODY_WALLET.purpose
    )
    .run();
}

/**
 * Inserts a legacy payment_wallet_policies row.
 *
 * @param row - The legacy row to insert, keyed the same way 0047 reads it.
 * @returns Resolves once the row is inserted.
 */
async function insertLegacyPolicy(row: LegacyPolicyRow): Promise<void> {
  await getDb(env)
    .prepare(
      "INSERT INTO payment_wallet_policies (id, custody_wallet_id, policy_type, policy) VALUES (?, ?, ?, ?)"
    )
    .bind(row.id, row.custodyWalletId, row.policyType, row.policy)
    .run();
}

/**
 * Seeds an already-active wallet_control_profiles row (with one activated
 * revision) for the test custody wallet, so a test can exercise the
 * "profile already exists" branches of 0047.
 *
 * @param options - The revision's rules and default_action.
 * @param options.rules - The rules JSONB array the seeded revision starts with.
 * @param options.defaultAction - The seeded revision's default_action.
 * @returns The seeded profile and revision ids.
 */
async function seedExistingProfile(options: {
  rules: Record<string, unknown>[];
  defaultAction: string;
}): Promise<SeedProfileResult> {
  const db = getDb(env);
  const profileId = "wcp_test_existing";
  const revisionId = "wcpr_test_existing_1";

  await db
    .prepare(
      `INSERT INTO wallet_control_profiles (
         id, organization_id, project_id, custody_wallet_id, name, status, active_revision_id, created_by
       ) VALUES (?, ?, ?, ?, 'Existing controls', 'active', ?, ?)`
    )
    .bind(profileId, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET.id, revisionId, TEST_USER.id)
    .run();

  await db
    .prepare(
      `INSERT INTO wallet_control_profile_revisions (
         id, profile_id, revision_number, rules, default_action, created_by, activated_at
       ) VALUES (?, ?, 1, ?::jsonb, ?, ?, sdp_iso_now())`
    )
    .bind(revisionId, profileId, JSON.stringify(options.rules), options.defaultAction, TEST_USER.id)
    .run();

  return { profileId, revisionId };
}

describe("0047_fold_payment_wallet_policies migration", () => {
  beforeAll(async () => {
    await recreateLegacyPaymentWalletPoliciesTable();
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await recreateLegacyPaymentWalletPoliciesTable();
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    await recreateLegacyPaymentWalletPoliciesTable();
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
    await seedOrgProjectAndWallet();
  });

  it("creates a new active profile and revision with both rules for a legacy-only wallet", async () => {
    await insertLegacyPolicy({
      id: "pwp_test_allowlist",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "destination_allowlist",
      policy: JSON.stringify({
        version: 1,
        destinationAllowlist: ["Recipient1111111111111111111111111111111"],
      }),
    });
    await insertLegacyPolicy({
      id: "pwp_test_limits",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "transfer_limits",
      policy: JSON.stringify({ version: 1, maxTransferAmount: "123.45", maxDailyAmount: "999" }),
    });

    await applyFoldMigrationSql();

    const profile = await getDb(env)
      .prepare(
        "SELECT id, status, active_revision_id FROM wallet_control_profiles WHERE custody_wallet_id = ?"
      )
      .bind(TEST_CUSTODY_WALLET.id)
      .first<WalletControlProfileRow>();
    expect(profile?.status).toBe("active");
    expect(profile?.active_revision_id).not.toBeNull();

    const revision = await getDb(env)
      .prepare(
        "SELECT id, profile_id, revision_number, rules, default_action FROM wallet_control_profile_revisions WHERE id = ?"
      )
      .bind(profile?.active_revision_id)
      .first<WalletControlProfileRevisionRow>();
    expect(revision?.revision_number).toBe(1);
    expect(revision?.default_action).toBe("allow");
    expect(revision?.rules).toEqual([
      {
        id: "converted-destination-allowlist",
        kind: "destination",
        allowlist: ["Recipient1111111111111111111111111111111"],
      },
      { id: "converted-max-transfer-amount", kind: "amount", max: "123.45" },
    ]);
  });

  it("appends only the missing amount rule to an active profile that already has a destination rule", async () => {
    const existing = await seedExistingProfile({
      rules: [
        {
          id: "manual-destination",
          kind: "destination",
          allowlist: ["ManualRecipient11111111111111111111111111"],
        },
      ],
      defaultAction: "review",
    });
    await insertLegacyPolicy({
      id: "pwp_test_limits",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "transfer_limits",
      policy: JSON.stringify({ version: 1, maxTransferAmount: "50" }),
    });

    await applyFoldMigrationSql();

    const profile = await getDb(env)
      .prepare(
        "SELECT id, status, active_revision_id FROM wallet_control_profiles WHERE custody_wallet_id = ?"
      )
      .bind(TEST_CUSTODY_WALLET.id)
      .first<WalletControlProfileRow>();
    expect(profile?.id).toBe(existing.profileId);
    expect(profile?.active_revision_id).not.toBe(existing.revisionId);

    const revision = await getDb(env)
      .prepare(
        "SELECT revision_number, rules, default_action FROM wallet_control_profile_revisions WHERE id = ?"
      )
      .bind(profile?.active_revision_id)
      .first<WalletControlProfileRevisionRow>();
    expect(revision?.revision_number).toBe(2);
    expect(revision?.default_action).toBe("review");
    expect(revision?.rules).toEqual([
      {
        id: "manual-destination",
        kind: "destination",
        allowlist: ["ManualRecipient11111111111111111111111111"],
      },
      { id: "converted-max-transfer-amount", kind: "amount", max: "50" },
    ]);
  });

  it("leaves a wallet untouched when its active profile already has both rule kinds", async () => {
    const existing = await seedExistingProfile({
      rules: [
        {
          id: "manual-destination",
          kind: "destination",
          allowlist: ["ManualRecipient11111111111111111111111111"],
        },
        { id: "manual-amount", kind: "amount", max: "1000" },
      ],
      defaultAction: "allow",
    });
    await insertLegacyPolicy({
      id: "pwp_test_allowlist",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "destination_allowlist",
      policy: JSON.stringify({
        version: 1,
        destinationAllowlist: ["OtherRecipient111111111111111111111111111"],
      }),
    });
    await insertLegacyPolicy({
      id: "pwp_test_limits",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "transfer_limits",
      policy: JSON.stringify({ version: 1, maxTransferAmount: "50" }),
    });

    await applyFoldMigrationSql();

    const profile = await getDb(env)
      .prepare(
        "SELECT id, active_revision_id FROM wallet_control_profiles WHERE custody_wallet_id = ?"
      )
      .bind(TEST_CUSTODY_WALLET.id)
      .first<WalletControlProfileRow>();
    expect(profile?.id).toBe(existing.profileId);
    expect(profile?.active_revision_id).toBe(existing.revisionId);

    const revisionCount = await getDb(env)
      .prepare(
        "SELECT COUNT(*)::int AS count FROM wallet_control_profile_revisions WHERE profile_id = ?"
      )
      .bind(existing.profileId)
      .first<{ count: number }>();
    expect(revisionCount?.count).toBe(1);
  });

  it("creates no profile when the allowlist is empty and there is no transfer limit", async () => {
    await insertLegacyPolicy({
      id: "pwp_test_empty_allowlist",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "destination_allowlist",
      policy: JSON.stringify({ version: 1, destinationAllowlist: [] }),
    });

    await applyFoldMigrationSql();

    const profile = await getDb(env)
      .prepare("SELECT id FROM wallet_control_profiles WHERE custody_wallet_id = ?")
      .bind(TEST_CUSTODY_WALLET.id)
      .first<{ id: string }>();
    expect(profile).toBeNull();
  });

  it("skips a malformed legacy policy row without crashing the migration", async () => {
    await insertLegacyPolicy({
      id: "pwp_test_malformed",
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      policyType: "destination_allowlist",
      policy: "{not valid json",
    });

    await expect(applyFoldMigrationSql()).resolves.toBeUndefined();

    const profile = await getDb(env)
      .prepare("SELECT id FROM wallet_control_profiles WHERE custody_wallet_id = ?")
      .bind(TEST_CUSTODY_WALLET.id)
      .first<{ id: string }>();
    expect(profile).toBeNull();
  });

  it("drops the legacy table", async () => {
    await applyFoldMigrationSql();

    const tableExists = await getDb(env)
      .prepare("SELECT to_regclass('payment_wallet_policies') AS regclass")
      .first<{ regclass: string | null }>();
    expect(tableExists?.regclass).toBeNull();
  });
});
