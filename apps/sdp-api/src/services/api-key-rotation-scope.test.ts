import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createTenantScope } from "@/lib/tenant-scope";
import { ApiKeyService, isApiKeyAlreadyRotated } from "@/services/api-key.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const TARGET_KEY_ID = "key_rotation_scope_target";
const SCOPE = createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id });

describe("rotateApiKey wallet-scope guard", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare("DELETE FROM api_keys WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run()
      .catch(() => {});
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Rotation Scope Project', ?, 'sandbox', 'active', ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix,
                               key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Rotation target', 'sk_test_rot', 'hash_rotation_scope',
                 'api_developer', '["tokens:read"]', 'active')`
      )
      .bind(TARGET_KEY_ID, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_rotation_scope_a', ?, 'wallet_rotation_a', '["tokens:read"]')`
      )
      .bind(TARGET_KEY_ID)
      .run();
  });

  it("hands the guard the bindings read inside the rotation transaction", async () => {
    // The handler's pre-flight check reads bindings before the rotation lock
    // is taken; a binding written after that read must still be what the
    // guard judges — the copy and the check have to see the same rows.
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_rotation_scope_b', ?, 'wallet_rotation_b', '["tokens:read"]')`
      )
      .bind(TARGET_KEY_ID)
      .run();

    const seen: string[][] = [];
    const rotation = await new ApiKeyService(getDb(env), SCOPE).rotateApiKey(
      TARGET_KEY_ID,
      TEST_ORG.id,
      TEST_PROJECT.id,
      24,
      ["*"],
      "pepper",
      ({ bindingWalletIds }) => {
        seen.push([...bindingWalletIds].sort());
      }
    );

    expect(rotation).not.toBeNull();
    expect(seen).toEqual([["wallet_rotation_a", "wallet_rotation_b"]]);
  });

  it("rolls the rotation back when the guard refuses", async () => {
    const service = new ApiKeyService(getDb(env), SCOPE);

    await expect(
      service.rotateApiKey(TARGET_KEY_ID, TEST_ORG.id, TEST_PROJECT.id, 24, ["*"], "pepper", () => {
        throw new Error("scope refused");
      })
    ).rejects.toThrow("scope refused");

    const replacement = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM api_keys WHERE rotated_from = ?")
      .bind(TARGET_KEY_ID)
      .first<{ count: number }>();
    expect(replacement).toEqual({ count: 0 });
  });

  it("still rotates when no guard is supplied", async () => {
    const rotation = await new ApiKeyService(getDb(env), SCOPE).rotateApiKey(
      TARGET_KEY_ID,
      TEST_ORG.id,
      TEST_PROJECT.id,
      24,
      ["*"],
      "pepper"
    );

    expect(rotation).not.toBeNull();
    if (!rotation || isApiKeyAlreadyRotated(rotation)) {
      throw new Error("expected a replacement key");
    }
  });
});
