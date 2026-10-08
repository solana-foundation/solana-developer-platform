import type { CustodyProvider } from "@sdp/custody";
import type { CustodyConfigStatus } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { insertTestCustodyConfigRow, insertTestCustodyWalletRow } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_custody_config_scope_integrity";
const PROJECT_ID = "prj_custody_config_scope_integrity";
const OTHER_PROJECT_ID = "prj_custody_config_scope_integrity_other";
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
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
}

async function insertConfig(
  id: string,
  projectId: string,
  provider: CustodyProvider
): Promise<void> {
  await insertTestCustodyConfigRow(getDb(env), {
    id,
    organizationId: ORGANIZATION_ID,
    projectId,
    provider,
    configEncrypted: "test-config",
    status: "active",
  });
}

async function insertWallet(id: string, configId: string, walletId: string): Promise<void> {
  await insertTestCustodyWalletRow(getDb(env), {
    id,
    owner: { kind: "config", custodyConfigId: configId },
    walletId,
    publicKey: `public_${id}`,
    label: null,
    purpose: null,
    status: "active",
  });
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

  it("enforces one project-level config per provider", async () => {
    await insertConfig("cust_scope_prj_a", PROJECT_ID, "privy");

    await expect(insertConfig("cust_scope_prj_b", PROJECT_ID, "privy")).rejects.toThrow(
      /idx_custody_configs_org_project_provider_unarchived/
    );
  });

  it("allows the same provider in distinct projects and distinct providers per project", async () => {
    await insertConfig("cust_scope_mix_prj", PROJECT_ID, "privy");
    await insertConfig("cust_scope_mix_other", OTHER_PROJECT_ID, "privy");
    await insertConfig("cust_scope_mix_para", PROJECT_ID, "para");

    const rows = await getDb(env)
      .prepare(
        "SELECT id, project_id, provider FROM custody_configs WHERE id IN (?, ?, ?) ORDER BY id"
      )
      .bind("cust_scope_mix_other", "cust_scope_mix_para", "cust_scope_mix_prj")
      .all<{ id: string; project_id: string; provider: string }>();
    expect(rows.results).toEqual([
      { id: "cust_scope_mix_other", project_id: OTHER_PROJECT_ID, provider: "privy" },
      { id: "cust_scope_mix_para", project_id: PROJECT_ID, provider: "para" },
      { id: "cust_scope_mix_prj", project_id: PROJECT_ID, provider: "privy" },
    ]);
  });

  it("requires the default wallet to belong to the same config", async () => {
    await insertConfig("cust_scope_fk_a", OTHER_PROJECT_ID, "privy");
    await insertConfig("cust_scope_fk_b", PROJECT_ID, "privy");
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
    await insertConfig("cust_scope_cascade", PROJECT_ID, "privy");
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

  it("resolves concurrent project-level upserts to a single config row", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    const configIds = (
      await Promise.all(
        Array.from({ length: 8 }, () =>
          store.saveProviderConfig({
            orgId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            provider: "para",
            configJson: { provider: "para" },
          })
        )
      )
    ).map((saved) => saved.configId);

    expect(new Set(configIds).size).toBe(1);
    const rows = await getDb(env).queryMany<{ id: string; status: CustodyConfigStatus }>(
      `SELECT id, status FROM custody_configs
       WHERE organization_id = ? AND project_id = ? AND provider = 'para'`,
      [ORGANIZATION_ID, PROJECT_ID]
    );
    expect(rows).toEqual([{ id: configIds[0], status: "active" }]);
  });

  it("persists the config payload and its wallet atomically without a default pointer", async () => {
    const store = new CustodyConfigStore(getDb(env), env);

    const { configId } = await store.saveProviderConfig({
      orgId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      configJson: { provider: "privy", privyAppId: "app_test" },
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
    expect(config).toEqual({ default_wallet_id: null, status: "active" });

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

    await insertConfig("cust_scope_rollback", PROJECT_ID, "para");
    await insertWallet("cwlt_scope_rollback", "cust_scope_rollback", "wallet_rollback");

    await expect(
      store.saveProviderConfig({
        orgId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "para",
        configJson: { provider: "para" },
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
