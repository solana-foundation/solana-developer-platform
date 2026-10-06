import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import {
  authenticateTestClerkUser,
  clerkHeadersWithoutProject,
  ensureTestClerkIssuer,
} from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { projectContextMiddleware } from "./project-context";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", kvStoreMiddleware());
  app.use("*", unifiedAuthMiddleware());
  app.use("*", projectContextMiddleware());
  app.get("/probe", (c) =>
    c.json({
      projectId: c.get("projectId"),
      projectEnvironment: c.get("projectEnvironment"),
    })
  );
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as 400 | 401 | 403);
    }
    throw error;
  });
  return app;
}

describe("projectContextMiddleware", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  let actor: Awaited<ReturnType<typeof authenticateTestClerkUser>>;

  beforeEach(async () => {
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
    });
    actor = await authenticateTestClerkUser(env, db, {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: "clerk_user_project_context",
      organizationId: TEST_ORG.id,
      clerkOrgId: "org_test_clerk_project_context",
      orgSlug: TEST_ORG.slug,
      role: "member",
    });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("resolves the header project for a Clerk user with membership", async () => {
    const res = await buildApp().request(
      "/probe",
      { headers: actor.headers(TEST_PROJECT.id) },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: TEST_PROJECT.id, projectEnvironment: "sandbox" });
  });

  it("requires the project header even when a query parameter is supplied", async () => {
    const res = await buildApp().request(
      `/probe?projectId=${TEST_PROJECT.id}`,
      { headers: clerkHeadersWithoutProject(actor.token) },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Project scope is required. Provide a x-project-id header.",
      },
    });
  });

  it("pins the API key project and ignores the project header", async () => {
    await seedCachedApiKey(
      env,
      await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER),
      TEST_CACHED_API_KEY
    );
    const res = await buildApp().request(
      "/probe",
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "x-project-id": "prj_test_missing",
        },
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: TEST_CACHED_API_KEY.projectId,
      projectEnvironment: TEST_CACHED_API_KEY.environment,
    });
  });

  it("returns 401 without authentication", async () => {
    const res = await buildApp().request(
      "/probe",
      { headers: { "x-project-id": TEST_PROJECT.id } },
      env
    );
    expect(res.status).toBe(401);
  });

  it("rejects a Clerk member requesting another organization's project", async () => {
    await getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind("org_test_inaccessible", "Other Organization", "test-inaccessible")
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: "org_test_inaccessible",
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: "prj_test_inaccessible", production: "prj_test_inaccessible_production" },
    });
    const res = await buildApp().request(
      "/probe",
      { headers: actor.headers("prj_test_inaccessible") },
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Requested project is not accessible",
      },
    });
  });
});
