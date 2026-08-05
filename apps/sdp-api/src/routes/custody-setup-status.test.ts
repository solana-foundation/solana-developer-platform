import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, CustodySetupStatusResponse } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_custody_setup_status",
  name: "Custody Setup Status Org",
  slug: "custody-setup-status-org",
};

const TEST_PROJECT = {
  id: "prj_custody_setup_status",
  slug: "custody-setup-status-project",
};

const TEST_USER = {
  id: "usr_custody_setup_status",
  email: "custody-setup-status@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_setup_status",
  raw: "sk_test_custody_setup_status",
  prefix: "sk_test_css",
};

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const CREDENTIAL_ID = "pcred_setup_status_privy";

async function seedBaseline(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Setup Status Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Setup Status Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

async function seedLegacyConfig(provider: string, configId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      configId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      provider,
      "test-config",
      "sdp-custody-encryption-v1",
      null,
      "active"
    )
    .run();
}

async function seedCredential(): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials
         (id, organization_id, project_id, provider, label, scope, source, storage_backend,
          encrypted_secret_payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      CREDENTIAL_ID,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy",
      "Privy credential",
      "project",
      "stored",
      "encrypted_db",
      "encrypted-test-payload",
      "active"
    )
    .run();
}

async function seedConnection(id: string, status: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_connections
         (id, organization_id, project_id, provider, scope, provider_credential_id,
          provider_credential_scope_key, status, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy",
      "project",
      CREDENTIAL_ID,
      TEST_PROJECT.id,
      status,
      // The schema requires an activation timestamp on an active connection.
      status === "active" ? "2026-08-05T00:00:00.000Z" : null
    )
    .run();
}

async function fetchSetupStatus(): Promise<CustodySetupStatusResponse> {
  const response = await app.request(
    "/v1/wallets/setup-status",
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: CustodySetupStatusResponse };
  return body.data;
}

function statusFor(response: CustodySetupStatusResponse, provider: string) {
  return response.providers.find((entry) => entry.provider === provider);
}

describe("custody setup status", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedBaseline();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("reports a provider with no rows as installable rather than installed", async () => {
    const status = await fetchSetupStatus();
    const privy = statusFor(status, "privy");

    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
    expect(privy?.connectionCounts).toEqual({
      pending: 0,
      checking: 0,
      active: 0,
      failed: 0,
      deactivated: 0,
    });
  });

  it("covers every known provider so the caller never has to guess", async () => {
    const status = await fetchSetupStatus();

    expect(status.providers.map((entry) => entry.provider)).toContain("fireblocks");
    expect(status.providers.length).toBeGreaterThanOrEqual(10);
  });

  it("reports an active legacy config as a config-backed target", async () => {
    await seedLegacyConfig("privy", "cust_cfg_setup_status_privy");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("ignores an inactive legacy config", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_inactive",
        TEST_ORG.id,
        TEST_PROJECT.id,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "inactive"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("counts connections by lifecycle without listing them", async () => {
    await seedCredential();
    await seedConnection("ccon_setup_status_pending", "pending");
    await seedConnection("ccon_setup_status_failed", "failed");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.connectionCounts.pending).toBe(1);
    expect(privy?.connectionCounts.failed).toBe(1);
    expect(privy?.connectionCounts.active).toBe(0);
    // A pending connection is not yet a signing target.
    expect(privy?.effectiveTargetType).toBe("none");
    expect(JSON.stringify(privy)).not.toContain("ccon_setup_status_pending");
  });

  it("keeps reporting the config while signing still resolves through it", async () => {
    await seedLegacyConfig("privy", "cust_cfg_setup_status_both");
    await seedCredential();
    await seedConnection("ccon_setup_status_active", "active");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.connectionCounts.active).toBe(1);
    // Signing never resolves through a connection today, so calling one the
    // effective target would report a migration that has not happened.
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("does not call a connection the signing target while nothing signs through it", async () => {
    await seedCredential();
    await seedConnection("ccon_setup_status_only", "active");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.connectionCounts.active).toBe(1);
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("counts an inherited organization config as installed for a project", async () => {
    // Signing falls back to the organization scope when a project has no config
    // of its own, so the project is installed even though it owns no row.
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_org_scope",
        TEST_ORG.id,
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("does not count another project's config as inherited", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "prj_setup_status_sibling",
        TEST_ORG.id,
        "Sibling",
        "sibling-setup-status",
        "sandbox",
        "active",
        TEST_USER.id
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_sibling",
        TEST_ORG.id,
        "prj_setup_status_sibling",
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("creates nothing while reading", async () => {
    const countRows = async (table: string) => {
      const row = await getDb(env).queryOne<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM ${table} WHERE organization_id = ?`,
        [TEST_ORG.id]
      );
      return Number(row?.total ?? 0);
    };
    // custody_wallets carries no organization_id; it is scoped through its config.
    const countWallets = async () => {
      const row = await getDb(env).queryOne<{ total: number | string }>(
        `SELECT COUNT(*) AS total
           FROM custody_wallets w
           JOIN custody_configs c ON c.id = w.custody_config_id
          WHERE c.organization_id = ?`,
        [TEST_ORG.id]
      );
      return Number(row?.total ?? 0);
    };

    const before = {
      configs: await countRows("custody_configs"),
      credentials: await countRows("provider_credentials"),
      connections: await countRows("custody_connections"),
      wallets: await countWallets(),
    };

    await fetchSetupStatus();
    await fetchSetupStatus();

    expect({
      configs: await countRows("custody_configs"),
      credentials: await countRows("provider_credentials"),
      connections: await countRows("custody_connections"),
      wallets: await countWallets(),
    }).toEqual(before);
  });

  it("does not leak another organization's setup", async () => {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind("org_setup_status_other", "Other", "other-setup-status", "standard", "active")
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_other",
        "org_setup_status_other",
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
  });
});
