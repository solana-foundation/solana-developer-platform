/**
 * Token Service Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TokenService } from "@/services/token.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT, TEST_PROJECT_API_KEY } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

describe("TokenService", () => {
  let db: DatabaseClient;
  let tokenService: TokenService;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    db = getDb(env);
    tokenService = new TokenService(db);

    await db
      .prepare("DELETE FROM frozen_accounts")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_tokens")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM users")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM organizations")
      .run()
      .catch(() => {});

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
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_PROJECT.organizationId,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        TEST_PROJECT.status,
        TEST_PROJECT.createdBy
      )
      .run();

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_PROJECT_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_PROJECT_API_KEY.prefix,
        "hash_unused_for_service_test"
      )
      .run();

    await db
      .prepare(
        `INSERT INTO issued_tokens (
          id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
          name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled,
          allowlist_enabled, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'Freezable Token', 'FRZ', 9, '0', 1, 1, 0, 'active', ?)`
      )
      .bind(
        "tok_freeze_refreeze",
        TEST_PROJECT.id,
        TEST_ORG.id,
        "So11111111111111111111111111111111111111112",
        "AENLi9e2xTiK7YHThmEQhBrCaDTjTRV4hsDXdwbPcBbxK9",
        "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod",
        TEST_PROJECT_API_KEY.id
      )
      .run();
  });

  it("reuses the existing frozen-account row after unfreeze", async () => {
    const firstFreeze = await tokenService.freezeAccount({
      tokenId: "tok_freeze_refreeze",
      accountAddress: "wallet_owner_1",
      frozenBy: TEST_USER.id,
      reason: "Initial freeze",
    });

    const thawed = await tokenService.unfreezeAccount(
      "tok_freeze_refreeze",
      "wallet_owner_1",
      TEST_USER.id
    );

    expect(thawed.unfrozenAt).not.toBeNull();

    const secondFreeze = await tokenService.freezeAccount({
      tokenId: "tok_freeze_refreeze",
      accountAddress: "wallet_owner_1",
      frozenBy: TEST_USER.id,
      reason: "Frozen again",
    });

    expect(secondFreeze.id).toBe(firstFreeze.id);
    expect(secondFreeze.reason).toBe("Frozen again");
    expect(secondFreeze.unfrozenAt).toBeNull();

    const storedRows = await db
      .prepare(
        `SELECT id, reason, unfrozen_at
         FROM frozen_accounts
         WHERE token_id = ? AND account_address = ?`
      )
      .bind("tok_freeze_refreeze", "wallet_owner_1")
      .all<{ id: string; reason: string | null; unfrozen_at: string | null }>();

    expect(storedRows.results).toHaveLength(1);
    expect(storedRows.results[0]?.id).toBe(firstFreeze.id);
    expect(storedRows.results[0]?.reason).toBe("Frozen again");
    expect(storedRows.results[0]?.unfrozen_at).toBeNull();
  });
});
