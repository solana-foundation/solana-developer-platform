import type { CachedApiKey } from "@sdp/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { projectContextMiddleware } from "@/middleware/project-context";
import { TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { authenticateTestClerkUser, ensureTestClerkIssuer } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

function buildApp(setup: (c: Context<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.get("/probe", (c) => c.json({ environment: resolveSdpEnvironment(c) }));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400 | 401 | 500);
    }
    throw err;
  });

  return app;
}

function apiKeyContext(environment: "sandbox" | "production"): CachedApiKey {
  return { ...TEST_CACHED_API_KEY, environment };
}

async function probe(setup: (c: Context<{ Bindings: Env }>) => void) {
  return buildApp(setup).request("/probe", {}, env);
}

describe("resolveSdpEnvironment", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  afterEach(async () => {
    await clearKVStores(env);
  });

  it("returns the API key's environment for key callers", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const res = await probe((c) => c.set("apiKey", apiKeyContext(environment)));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ environment });
    }
  });

  it("returns the membership-verified project environment for Clerk callers", async () => {
    await issuerReady;
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    const projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
    });
    const actor = await authenticateTestClerkUser(env, db, {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: "clerk_user_sdp_environment",
      organizationId: TEST_ORG.id,
      clerkOrgId: "org_test_clerk_sdp_environment",
      orgSlug: TEST_ORG.slug,
      role: "member",
    });
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", kvStoreMiddleware());
    app.use("*", unifiedAuthMiddleware());
    app.use("*", projectContextMiddleware());
    app.get("/probe", (c) => c.json({ environment: resolveSdpEnvironment(c) }));
    for (const environment of ["sandbox", "production"] as const) {
      const res = await app.request(
        "/probe",
        { headers: actor.headers(projects[environment].id) },
        env
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ environment });
    }
  });

  it("fails closed instead of defaulting when no environment is resolvable", async () => {
    const res = await probe(() => {});

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
