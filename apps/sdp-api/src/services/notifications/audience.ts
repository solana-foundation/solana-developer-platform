// Audience resolution for the notification dispatcher: who, live from membership at
// dispatch time. Extracted from the workflow notify action and generalized so
// non-workflow producers (invites, settlements, KYC) resolve the same way.

import { getDb } from "@/db";
import type { Env } from "@/types/env";

export type NotificationAudience = "admins" | "members";

export interface NotificationRecipient {
  userId: string;
  email: string | null;
}

// Role values are not canonical in storage: legacy rows carry Clerk-style
// 'org:admin' / 'org:owner' / bare 'owner' alongside 'admin' (mirrors
// normalizeOrganizationRole in @sdp/types permissions.ts).
export const ELEVATED_ROLES = ["admin", "owner", "org:admin", "org:owner"];

// Membership is scoped to `projectId` when given and the org uses project-level
// membership; members without a project_members row fall back to org-level membership
// so orgs that don't use project membership still resolve. Without a projectId the
// audience is the whole org.
export async function resolveOrgAudience(
  env: Env,
  params: {
    organizationId: string;
    projectId?: string | null;
    audience: NotificationAudience;
  }
): Promise<NotificationRecipient[]> {
  const roleFilter = params.audience === "members" ? "" : "AND om.role = ANY(?::text[])";

  if (!params.projectId) {
    const bindings: Array<string | string[]> = [params.organizationId];
    if (roleFilter) {
      bindings.push(ELEVATED_ROLES);
    }
    const result = await getDb(env)
      .prepare(
        `SELECT u.id AS user_id, u.email
           FROM organization_members om
           JOIN users u ON u.id = om.user_id
          WHERE om.organization_id = ? AND om.status = 'active'
            ${roleFilter}`
      )
      .bind(...bindings)
      .all<{ user_id: string; email: string | null }>();
    return result.results.map((row) => ({ userId: row.user_id, email: row.email }));
  }

  const bindings: Array<string | string[]> = [
    params.projectId,
    params.organizationId,
    params.projectId,
  ];
  if (roleFilter) {
    bindings.push(ELEVATED_ROLES);
  }
  const result = await getDb(env)
    .prepare(
      `SELECT u.id AS user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         LEFT JOIN project_members pm
           ON pm.user_id = om.user_id AND pm.project_id = ?
        WHERE om.organization_id = ? AND om.status = 'active'
          AND (pm.user_id IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ?))
          ${roleFilter}`
    )
    .bind(...bindings)
    .all<{ user_id: string; email: string | null }>();
  return result.results.map((row) => ({ userId: row.user_id, email: row.email }));
}

// Resolve explicit recipient ids to (userId, email), restricted to active members of
// the org — a stray or stale userId from a producer must not leak cross-org.
export async function resolveOrgMembersByIds(
  env: Env,
  params: { organizationId: string; userIds: string[] }
): Promise<NotificationRecipient[]> {
  if (params.userIds.length === 0) {
    return [];
  }
  const result = await getDb(env)
    .prepare(
      `SELECT u.id AS user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ? AND om.status = 'active'
          AND u.id = ANY(?::text[])`
    )
    .bind(params.organizationId, params.userIds)
    .all<{ user_id: string; email: string | null }>();
  return result.results.map((row) => ({ userId: row.user_id, email: row.email }));
}

// The notify action's `email` param addresses one mailbox directly — exactly the shape
// of an open relay. Restricting delivery to addresses that already belong to an active
// member of this organization keeps the escape hatch (alerting a specific admin)
// without letting a rule mail arbitrary third parties. Returns the member so callers
// can also preference-check the mailbox owner.
export async function findOrganizationMemberByEmail(
  env: Env,
  organizationId: string,
  email: string
): Promise<NotificationRecipient | null> {
  const row = await getDb(env)
    .prepare(
      `SELECT u.id AS user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ? AND om.status = 'active'
          AND LOWER(u.email) = LOWER(?)
        LIMIT 1`
    )
    .bind(organizationId, email)
    .first<{ user_id: string; email: string | null }>();
  return row ? { userId: row.user_id, email: row.email } : null;
}
