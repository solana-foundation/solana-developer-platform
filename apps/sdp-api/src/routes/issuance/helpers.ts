import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

async function ensureDefaultProject(
  c: AppContext,
  organizationId: string,
  userId: string
): Promise<string> {
  const existing = await getDb(c.env)
    .prepare(
      `SELECT p.id
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
     ORDER BY p.created_at ASC
     LIMIT 1`
    )
    .bind(organizationId, userId)
    .first<{ id: string }>();

  if (existing?.id) {
    return existing.id;
  }

  const projectId = `prj_${crypto.randomUUID()}`;
  const membershipId = `pm_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const defaultSlug = "default-project";

  try {
    await getDb(c.env).batch([
      getDb(c.env)
        .prepare(
          `INSERT INTO projects (
           id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at
         ) VALUES (?, ?, 'Default Project', ?, 'Auto-provisioned default project', 'sandbox', NULL, 'active', ?, ?, ?)`
        )
        .bind(projectId, organizationId, defaultSlug, userId, now, now),
      getDb(c.env)
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'admin', ?)`
        )
        .bind(membershipId, projectId, userId, now),
    ]);

    return projectId;
  } catch {
    const slugProject = await getDb(c.env)
      .prepare(
        `SELECT id, status
       FROM projects
       WHERE organization_id = ? AND slug = ?
       LIMIT 1`
      )
      .bind(organizationId, defaultSlug)
      .first<{ id: string; status: string }>();

    if (!slugProject?.id) {
      throw new AppError("INTERNAL_ERROR", "Failed to provision a default project");
    }

    if (slugProject.status !== "active") {
      await getDb(c.env)
        .prepare(
          `UPDATE projects
         SET status = 'active', updated_at = datetime('now')
         WHERE id = ?`
        )
        .bind(slugProject.id)
        .run();
    }

    await getDb(c.env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'admin', ?)
       ON CONFLICT (project_id, user_id) DO NOTHING`
      )
      .bind(`pm_${crypto.randomUUID()}`, slugProject.id, userId, now)
      .run();

    return slugProject.id;
  }
}

export const requireProjectScope = async (c: AppContext) => {
  const auth = getAuth(c);
  if (auth.projectId) {
    return { auth, projectId: auth.projectId, orgId: auth.organizationId };
  }

  if (auth.authType === "api_key") {
    throw new AppError("BAD_REQUEST", "Project-scoped API key required for token operations");
  }

  const requestedProjectId = c.req.query("projectId") ?? c.req.header("x-project-id") ?? null;

  if (requestedProjectId) {
    const project = auth.userId
      ? await getDb(c.env)
          .prepare(
            `SELECT p.id
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.id
           WHERE p.id = ? AND p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
           LIMIT 1`
          )
          .bind(requestedProjectId, auth.organizationId, auth.userId)
          .first<{ id: string }>()
      : await getDb(c.env)
          .prepare(
            `SELECT id
           FROM projects
           WHERE id = ? AND organization_id = ? AND status = 'active'
           LIMIT 1`
          )
          .bind(requestedProjectId, auth.organizationId)
          .first<{ id: string }>();

    if (!project) {
      throw new AppError("FORBIDDEN", "Requested project is not accessible");
    }

    return { auth, projectId: requestedProjectId, orgId: auth.organizationId };
  }

  const fallbackProject = auth.userId
    ? await getDb(c.env)
        .prepare(
          `SELECT p.id
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
         ORDER BY p.created_at ASC
         LIMIT 1`
        )
        .bind(auth.organizationId, auth.userId)
        .first<{ id: string }>()
    : await getDb(c.env)
        .prepare(
          `SELECT id
         FROM projects
         WHERE organization_id = ? AND status = 'active'
         ORDER BY created_at ASC
         LIMIT 1`
        )
        .bind(auth.organizationId)
        .first<{ id: string }>();

  if (!fallbackProject?.id) {
    if (auth.userId) {
      const defaultProjectId = await ensureDefaultProject(c, auth.organizationId, auth.userId);
      return { auth, projectId: defaultProjectId, orgId: auth.organizationId };
    }

    throw new AppError(
      "BAD_REQUEST",
      "No active project found for this organization. Create a project first."
    );
  }

  return { auth, projectId: fallbackProject.id, orgId: auth.organizationId };
};
