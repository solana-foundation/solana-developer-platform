/**
 * Auth Routes E2E Tests
 */

import { getPermissionsForOrgRole } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { SessionService } from "@/services/session.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

describe("Auth Routes", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    // Clear sessions table before each test
    const db = getDb(env);
    await db
      .prepare("DELETE FROM sessions")
      .run()
      .catch(() => {});

    // Prevent cached auth and rate-limit state from leaking between tests.
    await clearKVStores(env);
  });

  describe("GET /v1/auth/me (requires session)", () => {
    it("returns 401 without session cookie", async () => {
      const res = await app.request("/v1/auth/me", {}, env);

      expect(res.status).toBe(401);
    });
  });

  describe("session authorization state", () => {
    it("uses the current membership status and role instead of cached permissions", async () => {
      const db = getDb(env);
      const organizationId = "org_session_auth";
      const userId = "usr_session_auth";
      await db.batch([
        db
          .prepare(
            "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Session Auth', 'session-auth', 'individual', 'active')"
          )
          .bind(organizationId),
        db
          .prepare(
            "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'session-auth@example.com', 1, 'active')"
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES ('mem_session_auth', ?, ?, 'admin', 'active')"
          )
          .bind(organizationId, userId),
      ]);

      const sessionService = new SessionService(db, createKVStoreSet(env).sessions);
      const session = await sessionService.createSession(
        userId,
        organizationId,
        getPermissionsForOrgRole("admin"),
        {}
      );
      const requestOptions = {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sdp_session=${session.id}`,
        },
        body: JSON.stringify({}),
      };

      const activeAdmin = await app.request(
        `/v1/organizations/${organizationId}`,
        requestOptions,
        env
      );
      expect(activeAdmin.status).toBe(400);

      await db
        .prepare(
          "UPDATE organization_members SET role = 'member' WHERE organization_id = ? AND user_id = ?"
        )
        .bind(organizationId, userId)
        .run();

      const downgradedMember = await app.request(
        `/v1/organizations/${organizationId}`,
        requestOptions,
        env
      );
      expect(downgradedMember.status).toBe(403);

      await db
        .prepare(
          "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
        )
        .bind(organizationId, userId)
        .run();

      const removedMember = await app.request(
        `/v1/organizations/${organizationId}`,
        requestOptions,
        env
      );
      expect(removedMember.status).toBe(401);
      await expect(createKVStoreSet(env).sessions.get(`session:${session.id}`)).resolves.toBeNull();
    });
  });

  describe("POST /v1/auth/logout (requires session)", () => {
    it("returns 401 without session cookie", async () => {
      const res = await app.request("/v1/auth/logout", { method: "POST" }, env);

      expect(res.status).toBe(401);
    });
  });
});
