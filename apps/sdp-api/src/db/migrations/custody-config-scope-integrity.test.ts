import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_custody_config_scope_integrity";
const PROJECT_ID = "prj_custody_config_scope_integrity";
const USER_ID = "usr_custody_config_scope_integrity";

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Custody config scope integrity', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "custody-config-scope-integrity"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'custody-config-scope-integrity@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Custody config scope integrity', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "custody-config-scope-integrity", USER_ID),
  ]);
}

async function insertConfig(
  id: string,
  projectId: string | null,
  provider = "privy"
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_configs (
         id, organization_id, project_id, provider, config_encrypted,
         encryption_version, status
       ) VALUES (?, ?, ?, ?, 'test-config', 'test', 'active')`
    )
    .bind(id, ORGANIZATION_ID, projectId, provider)
    .run();
}

async function insertWallet(id: string, configId: string, walletId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(id, configId, walletId, `public_${id}`)
    .run();
}

async function setDefaultWallet(configId: string, walletId: string | null): Promise<void> {
  await getDb(env)
    .prepare("UPDATE custody_configs SET default_wallet_id = ? WHERE id = ?")
    .bind(walletId, configId)
    .run();
}

describe("custody Config scope integrity constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it("enforces one org-level config per provider", async () => {
    await insertConfig("cust_scope_org_a", null);

    await expect(insertConfig("cust_scope_org_b", null)).rejects.toThrow(
      /custody_configs_org_project_provider_key/
    );
  });

  it("enforces one project-level config per provider", async () => {
    await insertConfig("cust_scope_prj_a", PROJECT_ID);

    await expect(insertConfig("cust_scope_prj_b", PROJECT_ID)).rejects.toThrow(
      /custody_configs_org_project_provider_key/
    );
  });

  it("allows the same provider at distinct scopes and distinct providers per scope", async () => {
    await insertConfig("cust_scope_mix_org", null);
    await insertConfig("cust_scope_mix_prj", PROJECT_ID);
    await insertConfig("cust_scope_mix_para", null, "para");
  });

  it("requires the default wallet to belong to the same config", async () => {
    await insertConfig("cust_scope_fk_a", null);
    await insertConfig("cust_scope_fk_b", PROJECT_ID);
    await insertWallet("cwlt_scope_fk_a", "cust_scope_fk_a", "wallet_fk_a");
    await insertWallet("cwlt_scope_fk_b", "cust_scope_fk_b", "wallet_fk_b");

    await setDefaultWallet("cust_scope_fk_a", "wallet_fk_a");

    await expect(setDefaultWallet("cust_scope_fk_b", "wallet_missing")).rejects.toThrow(
      /custody_configs_default_wallet_fkey/
    );
    await expect(setDefaultWallet("cust_scope_fk_b", "wallet_fk_a")).rejects.toThrow(
      /custody_configs_default_wallet_fkey/
    );
  });

  it("cascade-deletes a config together with its wallets despite the default pointer", async () => {
    await insertConfig("cust_scope_cascade", null);
    await insertWallet("cwlt_scope_cascade", "cust_scope_cascade", "wallet_cascade");
    await setDefaultWallet("cust_scope_cascade", "wallet_cascade");

    await getDb(env).prepare("DELETE FROM custody_configs WHERE id = 'cust_scope_cascade'").run();

    expect(
      await getDb(env)
        .prepare("SELECT id FROM custody_wallets WHERE id = 'cwlt_scope_cascade'")
        .first()
    ).toBeNull();
  });
});

describe("custody Config scoped upsert concurrency", () => {
  let originalCustodyEncryptionKey: string | undefined;

  beforeEach(async () => {
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    await seedTestDatabase(env);
    await seedScope();
  });

  afterEach(() => {
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
  });

  it("resolves concurrent org-level upserts to a single config row", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    const configIds = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.upsert(ORGANIZATION_ID, undefined, { provider: "privy" })
      )
    );

    expect(new Set(configIds).size).toBe(1);

    const rows = await getDb(env)
      .prepare(
        `SELECT id FROM custody_configs
         WHERE organization_id = ? AND project_id IS NULL AND provider = 'privy'`
      )
      .bind(ORGANIZATION_ID)
      .all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.id).toBe(configIds[0]);
  });

  it("resolves concurrent project-level upserts to a single config row", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    const configIds = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.upsert(ORGANIZATION_ID, PROJECT_ID, { provider: "para" })
      )
    );

    expect(new Set(configIds).size).toBe(1);
  });

  it("persists the config payload, wallet, and default pointer atomically", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    const { configId } = await store.saveProviderConfig({
      orgId: ORGANIZATION_ID,
      projectId: undefined,
      provider: "privy",
      configJson: { provider: "privy", privyAppId: "app_test" },
      defaultWalletId: "wallet_atomic",
      wallet: {
        walletId: "wallet_atomic",
        publicKey: "public_atomic",
        label: "Atomic",
        purpose: "root",
      },
    });

    const config = await getDb(env)
      .prepare("SELECT default_wallet_id, status FROM custody_configs WHERE id = ?")
      .bind(configId)
      .first<{ default_wallet_id: string | null; status: string }>();
    expect(config).toMatchObject({ default_wallet_id: "wallet_atomic", status: "active" });

    const wallet = await getDb(env)
      .prepare(
        "SELECT status FROM custody_wallets WHERE custody_config_id = ? AND wallet_id = 'wallet_atomic'"
      )
      .bind(configId)
      .first<{ status: string }>();
    expect(wallet?.status).toBe("active");
  });

  it("rolls back the config upsert when the wallet insert fails", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    await insertConfig("cust_scope_rollback", null, "para");
    await insertWallet("cwlt_scope_rollback", "cust_scope_rollback", "wallet_rollback");

    await expect(
      store.saveProviderConfig({
        orgId: ORGANIZATION_ID,
        projectId: undefined,
        provider: "para",
        configJson: { provider: "para" },
        defaultWalletId: "wallet_rollback",
        // Duplicate (config, wallet_id) pair: the wallet insert violates
        // custody_wallets uniqueness and must roll the config update back.
        wallet: {
          walletId: "wallet_rollback",
          publicKey: "public_rollback_dup",
        },
      })
    ).rejects.toThrow();

    const config = await getDb(env)
      .prepare("SELECT config_encrypted FROM custody_configs WHERE id = 'cust_scope_rollback'")
      .first<{ config_encrypted: string }>();
    expect(config?.config_encrypted).toBe("test-config");
  });
});
