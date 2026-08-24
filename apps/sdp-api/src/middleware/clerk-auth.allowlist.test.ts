import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const ORG_ID = "org_clerk_allowlist";
const CLERK_ORG_ID = "clerk_org_allowlist";
const CLERK_USER_ID = "clerk_user_allowlist";
const USER_ID = "usr_clerk_allowlist";
const EMAIL = "clerk-allowlist@example.com";

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createApp(payload: ClerkJwtPayload) {
  const token = `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    c.set("verifiedClerkJwt", { token, payload });
    await next();
  });
  app.use("*", skipRateLimitPaths());
  app.use("*", unifiedAuthMiddleware({ allowClerk: true }));
  app.get("/protected", (c) => c.json({ organizationId: c.get("clerk")?.organizationId ?? null }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as 401 | 403);
    }
    throw error;
  });

  return { app, token };
}

/**
 * Sign-in provisions state — membership, default projects — so the allowlist
 * has to gate entry to that provisioning, not just the response after it: a
 * blocked origin must not leave rows behind.
 */
describe("Clerk auth against the organization IP allowlist", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env).batch([
      getDb(env)
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'individual', 'active', ?)"
        )
        .bind(
          ORG_ID,
          "Allowlist Org",
          "clerk-allowlist-org",
          JSON.stringify({ allowedIpAddresses: ["203.0.113.0/24"] })
        ),
      getDb(env)
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
             VALUES ('aoi_allowlist', 'clerk', ?, ?, 'clerk-allowlist-org')`
        )
        .bind(CLERK_ORG_ID, ORG_ID),
      // An established user with no membership in this organization yet, so a
      // sign-in would provision one (plus default projects).
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER_ID, EMAIL),
      getDb(env)
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
             VALUES ('aui_allowlist', 'clerk', ?, ?, ?)`
        )
        .bind(CLERK_USER_ID, USER_ID, EMAIL),
    ]);

    env.CLERK_ISSUER = "https://clerk.example.test";
    env.CLERK_JWKS_URL = undefined;
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  function payload(): ClerkJwtPayload {
    return {
      sub: CLERK_USER_ID,
      org_id: CLERK_ORG_ID,
      org_role: "org:member",
      org_slug: "clerk-allowlist-org",
      email: EMAIL,
      iss: "https://clerk.example.test",
    };
  }

  async function provisionedRows(): Promise<{ memberships: number; projects: number }> {
    const memberships = await getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM organization_members WHERE organization_id = ?")
      .bind(ORG_ID)
      .first<{ total: number }>();
    const projects = await getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM projects WHERE organization_id = ?")
      .bind(ORG_ID)
      .first<{ total: number }>();

    return { memberships: Number(memberships?.total ?? 0), projects: Number(projects?.total ?? 0) };
  }

  it("refuses a blocked origin before provisioning anything", async () => {
    const { app, token } = createApp(payload());

    const res = await app.request(
      "/protected",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "198.51.100.42",
        },
      },
      env
    );

    expect(res.status).toBe(403);
    // The refusal must precede the writes: no membership, no default projects.
    expect(await provisionedRows()).toEqual({ memberships: 0, projects: 0 });
  });

  it("provisions normally from an allowed origin", async () => {
    const { app, token } = createApp(payload());

    const res = await app.request(
      "/protected",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "203.0.113.42",
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: ORG_ID });

    const rows = await provisionedRows();
    expect(rows.memberships).toBe(1);
    expect(rows.projects).toBeGreaterThan(0);
  });
});
