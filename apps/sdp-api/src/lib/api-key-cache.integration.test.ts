/**
 * Regression test for the Hacktron finding: loadCachedApiKeyFromDb widened
 * an explicitly empty wallet-permissions array to the wildcard ["*"] while
 * building the auth cache entry, turning an attempt to strip a binding's
 * permissions into full administrative access to that wallet.
 *
 * The stored permissions are authoritative: an empty array grants nothing,
 * and only an absent list means the historical unrestricted default.
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { loadCachedApiKeyFromDb } from "@/lib/api-key-cache";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_cache_loader_perms",
  name: "Cache Loader Perms Org",
  slug: "cache-loader-perms-org",
};

const TEST_PROJECT = { id: "prj_cache_loader_perms", slug: "test-cache-loader-perms" };
const TEST_USER = { id: "usr_cache_loader_perms", email: "cache-loader-perms@example.com" };
const TEST_KEY = { id: "key_cache_loader_perms", raw: "sk_test_cache_loader_perms" };

describe("loadCachedApiKeyFromDb wallet binding permissions", () => {
  let keyHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);
    keyHash = await hashString(TEST_KEY.raw, env.API_KEY_PEPPER);

    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, ?, 'sk_test_clp', ?, 'api_admin', ?, 'active')`
        )
        .bind(
          TEST_KEY.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          TEST_KEY.id,
          keyHash,
          JSON.stringify(["*"])
        ),
      // Bindings only survive hydration when they resolve to exactly one
      // active custody wallet; without this config every binding would be
      // dropped as unresolved and the permissions under test never load.
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
           VALUES ('cust_cache_loader_perms', ?, ?, 'local', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
    ]);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  async function seedBindingRow(walletId: string, permissionsJson: string): Promise<void> {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cust_cache_loader_perms', ?, ?, 'active')`
      )
      .bind(`cwlt_${walletId}`, walletId, `${walletId}_public_key`)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`akw_${walletId}`, TEST_KEY.id, walletId, permissionsJson)
      .run();
  }

  it("keeps an explicitly empty permissions array empty instead of widening to wildcard", async () => {
    await seedBindingRow("wal_denied", "[]");
    await seedBindingRow("wal_scoped", JSON.stringify(["payments:read"]));

    const cached = await loadCachedApiKeyFromDb(getDb(env), keyHash);

    expect(cached).not.toBeNull();
    expect(cached?.walletBindings).toEqual([
      { walletId: "wal_denied", custodyWalletId: "cwlt_wal_denied", permissions: [] },
      {
        walletId: "wal_scoped",
        custodyWalletId: "cwlt_wal_scoped",
        permissions: ["payments:read"],
      },
    ]);
  });

  it("fails closed on an unparseable permissions value", async () => {
    await seedBindingRow("wal_corrupt", "not-json{");

    const cached = await loadCachedApiKeyFromDb(getDb(env), keyHash);

    expect(cached?.walletBindings).toEqual([
      { walletId: "wal_corrupt", custodyWalletId: "cwlt_wal_corrupt", permissions: [] },
    ]);
  });
});
