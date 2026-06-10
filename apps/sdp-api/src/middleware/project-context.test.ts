import type { CachedSession } from "@sdp/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { projectContextMiddleware } from "./project-context";

const ORG_ID = "org_project_context_mw";
const USER_ID = "usr_project_context_mw";
// Project the user is a member of.
const MEMBER_PROJECT_ID = "prj_project_context_member";
// Project in the same org the user is NOT a member of.
const FOREIGN_PROJECT_ID = "prj_project_context_foreign";

/**
 * Build a minimal app that runs only projectContextMiddleware, with the auth
 * context vars (session / apiKey) injected by a preceding middleware. The probe
 * handler echoes the resolved projectId so tests can assert what scope the
 * middleware settled on. AppErrors are mapped to their HTTP status the same way
 * the real app's error handler does.
 */
function buildApp(setup: (c: Context<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.use("*", projectContextMiddleware());
  app.get("/probe", (c) => c.json({ projectId: c.get("projectId") }));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400 | 401 | 403);
    }
    throw err;
  });

  return app;
}

const session: CachedSession = {
  userId: USER_ID,
  organizationId: ORG_ID,
} as CachedSession;

describe("projectContextMiddleware", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(ORG_ID, "Project Context MW Org", "project-context-mw-org")
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(USER_ID, "project-context-mw@example.com")
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Member Project', 'member-project', 'sandbox', 'active', ?)`
      )
      .bind(MEMBER_PROJECT_ID, ORG_ID, USER_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Foreign Project', 'foreign-project', 'sandbox', 'active', ?)`
      )
      .bind(FOREIGN_PROJECT_ID, ORG_ID, USER_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_project_context_mw', ?, ?, 'admin')`
      )
      .bind(MEMBER_PROJECT_ID, USER_ID)
      .run();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
  });

  it("resolves projectId from the x-project-id header for a project the session user belongs to", async () => {
    const app = buildApp((c) => c.set("session", session));

    const res = await app.request(
      "/probe",
      { headers: { "x-project-id": MEMBER_PROJECT_ID } },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectId: string };
    expect(body.projectId).toBe(MEMBER_PROJECT_ID);
  });

  it("rejects an x-project-id header for a project in the same org the user does not belong to", async () => {
    const app = buildApp((c) => c.set("session", session));

    const res = await app.request(
      "/probe",
      { headers: { "x-project-id": FOREIGN_PROJECT_ID } },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("no longer accepts the dropped ?projectId= query fallback and 400s without the header", async () => {
    const app = buildApp((c) => c.set("session", session));

    const res = await app.request(`/probe?projectId=${MEMBER_PROJECT_ID}`, {}, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Project scope is required. Provide a x-project-id header.");
  });

  it("pins projectId to the API key's project and ignores the x-project-id header", async () => {
    const app = buildApp((c) =>
      c.set("apiKey", {
        id: "key_project_context_mw",
        organizationId: ORG_ID,
        projectId: MEMBER_PROJECT_ID,
        role: "api_admin",
        permissions: ["*"],
        environment: "sandbox",
        signingWalletId: null,
      })
    );

    const res = await app.request(
      "/probe",
      { headers: { "x-project-id": FOREIGN_PROJECT_ID } },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectId: string };
    expect(body.projectId).toBe(MEMBER_PROJECT_ID);
  });

  it("returns 401 when neither API key nor session is present", async () => {
    const app = buildApp(() => {});

    const res = await app.request(
      "/probe",
      { headers: { "x-project-id": MEMBER_PROJECT_ID } },
      env
    );

    expect(res.status).toBe(401);
  });
});
