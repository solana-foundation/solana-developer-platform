import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TERMINAL_REFUSAL_TTL_MS } from "@/lib/api-key-refusal-cache";
import { isRotationDeadlineReached } from "@/lib/api-key-rotation";
import { AppError } from "@/lib/errors";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { authMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import {
  TEST_API_KEY,
  TEST_EXPIRED_KEY,
  TEST_REVOKED_KEY,
  TEST_SEEDED_API_KEY,
} from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { ensureTestClerkIssuer } from "@/test/helpers/clerk";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { archiveProject, seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

import type { Env } from "@/types/env";

describe("Auth Middleware", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  let validKeyHash: string;

  beforeEach(async () => {
    await issuerReady;
    await seedTestDatabase(env);

    await getDb(env)
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();

    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  describe("key extraction", () => {
    it("accepts Bearer token format", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).not.toBe(401);
    });

    it("accepts raw key format", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: TEST_API_KEY.raw,
          },
        },
        env
      );

      expect(res.status).not.toBe(401);
    });

    it("rejects requests without Authorization header", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {},
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects invalid Authorization header format", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: "Basic invalid",
          },
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("key validation", () => {
    it("rejects invalid key format (not sk_test or sk_live)", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: "Bearer invalid_key_format",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("rejects unknown API keys", async () => {
      const unknownKey = "sk_test_unknown_fixture";

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${unknownKey}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("accepts a valid API key", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("rejects an API key used outside its IPv4 allowlist", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "198.51.100.42",
          },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("accepts an API key used from an allowed IPv4 address", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "203.0.113.42",
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("uses the Cloud Run verified client instead of an untrusted forwarded prefix", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        allowedIps: ["198.51.100.99/32"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "198.51.100.99, 203.0.113.10, 192.0.2.20",
          },
        },
        { ...env, K_SERVICE: "sdp-api" }
      );

      expect(res.status).toBe(403);
    });

    it("rejects a restricted API key when no trusted client IP is available", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it("rejects malformed allowlist data stored on the key", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        allowedIps: ["not-an-ip-range"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "203.0.113.42",
          },
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it("enforces the allowlist after loading an API key from Postgres", async () => {
      await getDb(env)
        .prepare("INSERT INTO users (id, email, status) VALUES (?, ?, ?), (?, ?, ?)")
        .bind(
          TEST_USER.id,
          TEST_USER.email,
          TEST_USER.status,
          "usr_test_api_key_creator",
          "api-key-creator@example.com",
          "active"
        )
        .run();
      await seedDefaultProjects(getDb(env), {
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        members: [],
        ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
      });
      await getDb(env)
        .prepare(
          `INSERT INTO api_keys (
             id, organization_id, project_id, created_by, name, key_prefix, key_hash,
             role, allowed_ips, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          TEST_API_KEY.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          "usr_test_api_key_creator",
          "Restricted key",
          TEST_API_KEY.prefix,
          validKeyHash,
          "api_admin",
          JSON.stringify(["203.0.113.0/24"]),
          "active"
        )
        .run();

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "198.51.100.42",
          },
        },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe("key status validation", () => {
    it("treats the exact rotation deadline as expired for a zero-hour grace period", () => {
      const deadline = "2026-07-23T12:00:00.000Z";
      const deadlineMs = Date.parse(deadline);

      expect(isRotationDeadlineReached(deadline, deadlineMs - 1)).toBe(false);
      expect(isRotationDeadlineReached(deadline, deadlineMs)).toBe(true);
    });

    it("fails closed when a persisted rotation deadline is malformed", () => {
      expect(isRotationDeadlineReached("not-a-timestamp", Date.now())).toBe(true);
    });

    it("rejects revoked API keys", async () => {
      const revokedKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
      await seedApiKeyRow(env, revokedKeyHash, TEST_REVOKED_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("REVOKED_API_KEY");
    });

    it("rejects expired API keys", async () => {
      const expiredKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
      await seedApiKeyRow(env, expiredKeyHash, TEST_EXPIRED_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    // A malformed expiry fails closed instead of reading as "not expired".
    it("rejects a key whose expiry does not parse", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        expiresAt: "not-a-timestamp",
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    it("rejects rotated API keys after their grace period ends", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        rotationDeadline: "2020-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    it("accepts rotated API keys while their grace period is active", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        rotationDeadline: "2999-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });
  });

  // HOO-2048: authentication reads the key's wallet bindings in its uncached
  // statement, so a change to them applies on the next request.
  describe("fresh wallet bindings", () => {
    const walletRequest = (walletId: string) =>
      app.request(
        `/v1/wallets/${walletId}?includeBalance=false`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

    beforeEach(async () => {
      await getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email)
        .run();
      await seedDefaultProjects(getDb(env), {
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        members: [],
        ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
      });
      await seedTestCustodyRows(env, {
        configs: [
          {
            id: "cust_fresh_bindings",
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            provider: "local",
            configEncrypted: "test-config",
            status: "active",
          },
        ],
        wallets: ["a", "b"].map((suffix) => ({
          id: `cwlt_fresh_${suffix}`,
          owner: { kind: "config" as const, custodyConfigId: "cust_fresh_bindings" },
          walletId: `wallet_fresh_${suffix}`,
          publicKey: `wallet_fresh_${suffix}_public_key`,
          label: null,
          purpose: null,
          status: "active" as const,
        })),
      });
    });

    it("refuses a key narrowed from all wallets to selected ones on its next request", async () => {
      await seedApiKeyRow(env, validKeyHash, { ...TEST_SEEDED_API_KEY, walletScope: "all" });
      expect((await walletRequest("wallet_fresh_b")).status).toBe(200);

      await getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES ('akw_fresh_narrowed', ?, 'wallet_fresh_a', '["*"]')`
        )
        .bind(TEST_API_KEY.id)
        .run();
      expect((await walletRequest("wallet_fresh_b")).status).toBe(404);
      expect((await walletRequest("wallet_fresh_a")).status).toBe(200);
    });

    it("refuses a wallet whose binding was revoked on its next request", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        walletScope: "selected",
        signingWalletId: "wallet_fresh_a",
        walletBindings: [
          { walletId: "wallet_fresh_a", custodyWalletId: "cwlt_fresh_a", permissions: ["*"] },
          { walletId: "wallet_fresh_b", custodyWalletId: "cwlt_fresh_b", permissions: ["*"] },
        ],
      });
      expect((await walletRequest("wallet_fresh_b")).status).toBe(200);

      await getDb(env)
        .prepare(
          "DELETE FROM api_key_wallet_permissions WHERE api_key_id = ? AND wallet_id = 'wallet_fresh_b'"
        )
        .bind(TEST_API_KEY.id)
        .run();

      expect((await walletRequest("wallet_fresh_b")).status).toBe(404);
      expect((await walletRequest("wallet_fresh_a")).status).toBe(200);
    });
  });

  // HOO-2099: every authorization field comes from the key's live rows, read
  // once per request, so a change applies on the very next request.
  describe("fresh authorization", () => {
    const contextApp = () => {
      const mini = new Hono<{ Bindings: Env }>();
      mini.onError((err, c) => {
        if (err instanceof AppError) {
          // SAFETY: AppError status codes are the API's own error statuses.
          return c.json(err.toResponse(), err.statusCode as 401 | 403);
        }
        throw err;
      });
      mini.use("*", kvStoreMiddleware());
      mini.use("*", authMiddleware());
      mini.get("/context", (c) => c.json(c.get("apiKey")));
      mini.get("/transfer", requireAllowedOperation("payment_transfer_execute"), (c) =>
        c.json({ ok: true })
      );
      return mini;
    };
    const keyed = (path: string, headers: Record<string, string> = {}) =>
      contextApp().request(
        path,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}`, ...headers } },
        env
      );
    const orgRequest = () =>
      app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
    const updateKey = (assignment: string, value: string | null) =>
      getDb(env)
        .prepare(`UPDATE api_keys SET ${assignment} = ? WHERE id = ?`)
        .bind(value, TEST_API_KEY.id)
        .run();

    beforeEach(async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
    });

    it("builds the request context from the key's row", async () => {
      await updateKey("role", "api_developer");
      await updateKey("permissions", JSON.stringify(["org:read"]));

      const res = await keyed("/context");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: TEST_API_KEY.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        role: "api_developer",
        permissions: ["org:read"],
        environment: "sandbox",
        allowedOperations: null,
        walletScope: "all",
      });
    });

    it("applies a permission reduction on the next request", async () => {
      expect((await orgRequest()).status).toBe(200);

      await updateKey("permissions", JSON.stringify(["tokens:read"]));

      const res = await orgRequest();
      expect(res.status).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });

    it("applies an Allowed Operations change on the next request", async () => {
      expect((await keyed("/transfer")).status).toBe(200);

      await updateKey("allowed_operations", JSON.stringify(["ramp"]));

      expect((await keyed("/transfer")).status).toBe(403);
      expect(await (await keyed("/context")).json()).toMatchObject({
        allowedOperations: ["ramp"],
      });
    });

    it("applies an IP restriction on the next request", async () => {
      const origin = { "x-forwarded-for": "198.51.100.42" };
      expect((await keyed("/context", origin)).status).toBe(200);

      await updateKey("allowed_ips", JSON.stringify(["203.0.113.0/24"]));

      const res = await keyed("/context", origin);
      expect(res.status).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("refuses a key whose project was archived on its next request", async () => {
      expect((await keyed("/context")).status).toBe(200);

      await archiveProject(getDb(env), TEST_PROJECT.id);

      const res = await keyed("/context");
      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("REVOKED_API_KEY");
    });

    it("refuses a key revoked after its last request", async () => {
      expect((await keyed("/context")).status).toBe(200);

      await updateKey("status", "revoked");

      const body = errorBodySchema.parse(await (await keyed("/context")).json());
      expect(body.error.code).toBe("REVOKED_API_KEY");
    });

    it("refuses a key whose rotation deadline passed after its last request", async () => {
      expect((await keyed("/context")).status).toBe(200);

      await updateKey("rotation_deadline", new Date(Date.now() - 1_000).toISOString());

      const body = errorBodySchema.parse(await (await keyed("/context")).json());
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    it("refuses a key whose organization was deleted", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();

      const res = await keyed("/context");
      expect(res.status).toBe(401);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("REVOKED_API_KEY");
    });

    const authReads = (prepare: { mock: { calls: unknown[][] } }) =>
      prepare.mock.calls.filter(([sql]) => String(sql).includes("FROM api_keys ak")).length;

    it("refuses a revoked key from memory on its next attempt", async () => {
      await updateKey("status", "revoked");
      const prepare = vi.spyOn(getDb(env), "prepare");

      const first = errorBodySchema.parse(await (await keyed("/context")).json());
      expect(first.error.code).toBe("REVOKED_API_KEY");
      expect(authReads(prepare)).toBe(1);

      const second = errorBodySchema.parse(await (await keyed("/context")).json());
      expect(second.error.code).toBe("REVOKED_API_KEY");
      expect(authReads(prepare)).toBe(1);
    });

    it("refuses an unknown key from memory on its next attempt", async () => {
      const prepare = vi.spyOn(getDb(env), "prepare");
      const unknown = () =>
        contextApp().request(
          "/context",
          { headers: { Authorization: "Bearer sk_test_never_issued_fixture" } },
          env
        );

      expect((await unknown()).status).toBe(401);
      expect((await unknown()).status).toBe(401);
      expect(authReads(prepare)).toBe(1);
    });

    it("forgets a terminal refusal after its TTL", async () => {
      await updateKey("status", "revoked");
      expect((await keyed("/context")).status).toBe(401);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + TERMINAL_REFUSAL_TTL_MS + 1);
      const prepare = vi.spyOn(getDb(env), "prepare");

      expect((await keyed("/context")).status).toBe(401);
      expect(authReads(prepare)).toBe(1);
    });

    // An inactive project can be restored, so its refusal is never remembered.
    it("does not remember a refusal that can lift", async () => {
      await archiveProject(getDb(env), TEST_PROJECT.id);
      expect((await keyed("/context")).status).toBe(401);

      await getDb(env)
        .prepare("UPDATE projects SET status = 'active' WHERE id = ?")
        .bind(TEST_PROJECT.id)
        .run();

      expect((await keyed("/context")).status).toBe(200);
    });

    it("reads the key's rows in one statement per request", async () => {
      const prepare = vi.spyOn(getDb(env), "prepare");

      expect((await keyed("/context")).status).toBe(200);

      const authReads = prepare.mock.calls.filter(([sql]) => sql.includes("FROM api_keys ak"));
      expect(authReads).toHaveLength(1);
    });
  });

  describe("permissions", () => {
    it("allows access with wildcard permission", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        permissions: ["*"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("allows access with specific permission", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        permissions: ["org:read", "org:write"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("rejects requests without required permissions", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        permissions: ["tokens:read"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_SEEDED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });
  });
});
