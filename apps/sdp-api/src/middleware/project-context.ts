import type { SdpEnvironment } from "@sdp/types";
import type { Context, Next } from "hono";
import { type DatabaseExecutor, getDb } from "@/db";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/errors";
import { isProductionEntitled, productionNotEnabled } from "@/lib/production-entitlement";
import type { Env } from "@/types/env";

const PROJECT_HEADER = "x-project-id";

export interface ProjectContextOptions {
  /**
   * Requests that may act on a production project after the organization lost
   * the production entitlement. Only for exits that must stay open for money
   * already deployed (Earn withdrawals and reads, ADR 0002); never for anything
   * that starts new exposure.
   */
  allowUnentitledProduction?: (c: Context<{ Bindings: Env }>) => boolean | Promise<boolean>;
  /**
   * Take the project from this path parameter instead of the `x-project-id`
   * header, for routes that address a project in their URL (`/v1/projects/:projectId`).
   * Dashboard actors there keep organization-level project permissions, so the
   * project is resolved within the organization without a membership check;
   * the handlers keep their own authorization. API keys must name their own
   * project (`apiKeyProjectAccessMiddleware` runs first).
   */
  projectIdParam?: string;
}

/**
 * Settles the project and environment a request acts on, for every actor
 * (API key, Clerk, approved-operation replay), and is the one place that
 * refuses a production project whose organization lacks the production
 * entitlement (APE-351). Listing filters alone left stale selectors, production
 * API keys and approval replays working.
 */
export function projectContextMiddleware(options: ProjectContextOptions = {}) {
  // Named, so the route inventory test can see which routes it guards.
  return async function projectContext(c: Context<{ Bindings: Env }>, next: Next) {
    const scope = options.projectIdParam
      ? await resolvePathProjectScope(c, options.projectIdParam)
      : await resolveProjectScope(c);

    if (
      scope.environment === "production" &&
      !isProductionEntitled(c) &&
      !(await options.allowUnentitledProduction?.(c))
    ) {
      throw productionNotEnabled();
    }

    c.set("projectId", scope.projectId);
    c.set("projectEnvironment", scope.environment);
    await next();
  };
}

async function resolveProjectScope(c: Context<{ Bindings: Env }>): Promise<{
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
}> {
  // An API key is pinned to its project, whether it authenticated this request
  // or an approved-operation replay restored it.
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return {
      organizationId: apiKey.organizationId,
      projectId: apiKey.projectId,
      environment: apiKey.environment,
    };
  }

  const clerk = c.get("clerk");
  const replayActor = c.get("approvedOperationActor");
  const orgId = clerk?.organizationId ?? replayActor?.organizationId;
  const userId = clerk?.userId ?? replayActor?.userId;

  if (!orgId || !userId) {
    throw unauthorized("Authentication is required");
  }

  const requested = c.req.header(PROJECT_HEADER) ?? null;

  if (!requested) {
    throw badRequest(`Project scope is required. Provide a ${PROJECT_HEADER} header.`);
  }

  const project = await assertProjectMembership(c, orgId, userId, requested);
  return { organizationId: orgId, projectId: project.id, environment: project.environment };
}

async function resolvePathProjectScope(
  c: Context<{ Bindings: Env }>,
  param: string
): Promise<{ organizationId: string; projectId: string; environment: SdpEnvironment }> {
  // Mounted only under a `/:projectId` path, so the parameter is always present.
  const projectId = c.req.param(param) as string;
  const organizationId =
    c.get("apiKey")?.organizationId ??
    c.get("clerk")?.organizationId ??
    c.get("approvedOperationActor")?.organizationId;
  if (!organizationId) {
    throw unauthorized("Authentication is required");
  }
  const apiKey = c.get("apiKey");
  if (apiKey && apiKey.projectId !== projectId) {
    throw notFound("Project");
  }

  const row = await getDb(c.env)
    .prepare("SELECT id, environment FROM projects WHERE id = ? AND organization_id = ? LIMIT 1")
    .bind(projectId, organizationId)
    .first<{ id: string; environment: SdpEnvironment }>();
  if (!row) {
    throw notFound("Project");
  }
  return { organizationId, projectId: row.id, environment: row.environment };
}

async function assertProjectMembership(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  userId: string,
  projectId: string
): Promise<MemberProject> {
  const row = await findMemberProject(getDb(c.env), { organizationId, userId, projectId });

  if (!row) {
    throw forbidden("Requested project is not accessible");
  }

  return row;
}

/** An active project the user is a member of. */
export interface MemberProject {
  id: string;
  environment: SdpEnvironment;
}

/**
 * Finds `projectId` when it is an active project of `organizationId` and
 * `userId` has a `project_members` row for it: the membership rule every
 * dashboard-session project scope is admitted by.
 *
 * @param db - Database client for the project and membership rows.
 * @param params - The project lookup.
 * @param params.organizationId - The caller's organization.
 * @param params.userId - The dashboard user.
 * @param params.projectId - The project the caller names.
 * @returns The project, or null when it is outside the organization, archived,
 *   or the user is not a member.
 */
export async function findMemberProject(
  db: DatabaseExecutor,
  params: { organizationId: string; userId: string; projectId: string }
): Promise<MemberProject | null> {
  return db
    .prepare(
      `SELECT p.id, p.environment
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
       LIMIT 1`
    )
    .bind(params.projectId, params.organizationId, params.userId)
    .first<MemberProject>();
}
