/**
 * Token Service Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
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

  describe("updateToken undeployed guard", () => {
    async function insertToken(
      id: string,
      overrides: { mintAddress?: string | null; status?: string }
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO issued_tokens (
            id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
            name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled,
            allowlist_enabled, status, created_by
          ) VALUES (?, ?, ?, ?, NULL, NULL, 'Guarded Token', 'GRD', 9, '0', 1, 1, 0, ?, ?)`
        )
        .bind(
          id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          overrides.mintAddress ?? null,
          overrides.status ?? "pending",
          TEST_PROJECT_API_KEY.id
        )
        .run();
    }

    it("applies symbol/decimals changes while the token is an undeployed draft", async () => {
      await insertToken("tok_guard_pending", { status: "pending", mintAddress: null });

      const updated = await tokenService.updateToken("tok_guard_pending", {
        symbol: "RENAMED",
        decimals: 2,
      });

      expect(updated.symbol).toBe("RENAMED");
      expect(updated.decimals).toBe(2);
    });

    it("refuses symbol/decimals changes once the token is deployed (optimistic lock)", async () => {
      // Simulates a deploy landing between the handler's guard read and this
      // write: the row is active with a mint by the time the UPDATE runs.
      await insertToken("tok_guard_deployed", {
        status: "active",
        mintAddress: "Dep1oyed11111111111111111111111111111111111",
      });

      await expect(
        tokenService.updateToken("tok_guard_deployed", { symbol: "RENAMED", decimals: 2 })
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await db
        .prepare("SELECT symbol, decimals FROM issued_tokens WHERE id = ?")
        .bind("tok_guard_deployed")
        .first<{ symbol: string; decimals: number }>();
      expect(row?.symbol).toBe("GRD");
      expect(row?.decimals).toBe(9);
    });

    it("still allows metadata (name) changes on a deployed token", async () => {
      await insertToken("tok_guard_metadata", {
        status: "active",
        mintAddress: "Metadata111111111111111111111111111111111111",
      });

      const updated = await tokenService.updateToken("tok_guard_metadata", {
        name: "New Display Name",
      });

      expect(updated.name).toBe("New Display Name");
    });

    it("throws a plain not-found error for a missing token", async () => {
      await expect(
        tokenService.updateToken("tok_does_not_exist", { name: "Nope" })
      ).rejects.toThrow("TOKEN_NOT_FOUND");
      await expect(
        tokenService.updateToken("tok_does_not_exist", { name: "Nope" })
      ).rejects.not.toBeInstanceOf(AppError);
    });
  });
});
