/**
 * Magic Link Service Unit Tests
 */

import { hashString } from "@/lib/hash";
import { MagicLinkService } from "@/services/magic-link.service";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/nursery/noSecrets: Test suite name, not a secret
describe("MagicLinkService", () => {
  let magicLinkService: MagicLinkService;
  let db: D1Database;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    db = (env as { DB: D1Database }).DB;
    magicLinkService = new MagicLinkService(db);

    // Clear magic_links table
    await db
      .prepare("DELETE FROM magic_links")
      .run()
      .catch(() => {});

    // Seed org
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
  });

  describe("createMagicLink", () => {
    it("creates a magic link for email", async () => {
      const result = await magicLinkService.createMagicLink("test@example.com");

      expect(result.id).toMatch(/^ml_/);
      expect(result.token).toHaveLength(43);
      expect(result.expiresAt).toBeDefined();

      // Verify stored in DB
      const stored = await db
        .prepare("SELECT * FROM magic_links WHERE id = ?")
        .bind(result.id)
        .first();

      expect(stored).not.toBeNull();
      expect(stored?.email).toBe("test@example.com");
    });

    it("creates magic link with organization reference", async () => {
      const result = await magicLinkService.createMagicLink("org@example.com", TEST_ORG.id);

      const stored = await db
        .prepare("SELECT organization_id FROM magic_links WHERE id = ?")
        .bind(result.id)
        .first<{ organization_id: string }>();

      expect(stored?.organization_id).toBe(TEST_ORG.id);
    });

    it("invalidates previous unused magic links for same email", async () => {
      const first = await magicLinkService.createMagicLink("multi@example.com");
      const second = await magicLinkService.createMagicLink("multi@example.com");

      // First should be marked as used
      const firstStored = await db
        .prepare("SELECT used_at FROM magic_links WHERE id = ?")
        .bind(first.id)
        .first<{ used_at: string | null }>();

      expect(firstStored?.used_at).not.toBeNull();

      // Second should be unused
      const secondStored = await db
        .prepare("SELECT used_at FROM magic_links WHERE id = ?")
        .bind(second.id)
        .first<{ used_at: string | null }>();

      expect(secondStored?.used_at).toBeNull();
    });

    it("lowercases email addresses", async () => {
      await magicLinkService.createMagicLink("UPPER@EXAMPLE.COM");

      const stored = await db
        .prepare("SELECT email FROM magic_links WHERE email = ?")
        .bind("upper@example.com")
        .first();

      expect(stored).not.toBeNull();
    });
  });

  describe("verifyMagicLink", () => {
    it("verifies valid token and marks as used", async () => {
      const { token } = await magicLinkService.createMagicLink("verify@example.com");

      const result = await magicLinkService.verifyMagicLink(token);

      expect(result).not.toBeNull();
      expect(result?.email).toBe("verify@example.com");

      // Should be marked as used
      const tokenHash = await hashString(token);
      const stored = await db
        .prepare("SELECT used_at FROM magic_links WHERE token_hash = ?")
        .bind(tokenHash)
        .first<{ used_at: string | null }>();

      expect(stored?.used_at).not.toBeNull();
    });

    it("returns organization ID if set", async () => {
      const { token } = await magicLinkService.createMagicLink("org@example.com", TEST_ORG.id);

      const result = await magicLinkService.verifyMagicLink(token);

      expect(result?.organizationId).toBe(TEST_ORG.id);
    });

    it("returns null for invalid token", async () => {
      const result = await magicLinkService.verifyMagicLink("invalidtoken");

      expect(result).toBeNull();
    });

    it("returns null for expired token", async () => {
      // Create link directly with expired timestamp using SQLite datetime format
      // biome-ignore lint/nursery/noSecrets: Test token fixture, not a real secret
      const token = "expiredtoken123456789012345678901234567890";
      const tokenHash = await hashString(token);

      await db
        .prepare(
          "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '-1 hour'))"
        )
        .bind("ml_expired", "expired@example.com", tokenHash)
        .run();

      const result = await magicLinkService.verifyMagicLink(token);

      expect(result).toBeNull();
    });

    it("returns null for already used token", async () => {
      const { token } = await magicLinkService.createMagicLink("used@example.com");

      // Use it once
      await magicLinkService.verifyMagicLink(token);

      // Try to use again
      const result = await magicLinkService.verifyMagicLink(token);

      expect(result).toBeNull();
    });
  });

  // biome-ignore lint/nursery/noSecrets: Test suite name, not a secret
  describe("invalidateMagicLink", () => {
    it("marks magic link as used", async () => {
      const { id } = await magicLinkService.createMagicLink("invalidate@example.com");

      await magicLinkService.invalidateMagicLink(id);

      const stored = await db
        .prepare("SELECT used_at FROM magic_links WHERE id = ?")
        .bind(id)
        .first<{ used_at: string | null }>();

      expect(stored?.used_at).not.toBeNull();
    });
  });

  describe("getMagicLink", () => {
    it("returns magic link details", async () => {
      const created = await magicLinkService.createMagicLink("get@example.com");

      const result = await magicLinkService.getMagicLink(created.id);

      expect(result).not.toBeNull();
      expect(result?.email).toBe("get@example.com");
      expect(result?.id).toBe(created.id);
    });

    it("returns null for non-existent ID", async () => {
      const result = await magicLinkService.getMagicLink("ml_nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("cleanupExpired", () => {
    it("removes expired magic links", async () => {
      // Create expired link directly using SQLite datetime format
      await db
        .prepare(
          "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '-1 hour'))"
        )
        .bind("ml_cleanup", "cleanup@example.com", "hash123")
        .run();

      // Verify it exists before cleanup
      const beforeCleanup = await db
        .prepare("SELECT * FROM magic_links WHERE id = ?")
        .bind("ml_cleanup")
        .first();
      expect(beforeCleanup).not.toBeNull();

      await magicLinkService.cleanupExpired();

      // Verify it's gone after cleanup
      const afterCleanup = await db
        .prepare("SELECT * FROM magic_links WHERE id = ?")
        .bind("ml_cleanup")
        .first();

      expect(afterCleanup).toBeNull();
    });
  });
});
