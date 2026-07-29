import { getDb } from "@/db";
import { createNotificationsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { createTransactionalEmailService, isEmailConfigured } from "@/services/email";
import type { Env } from "@/types/env";
import { errorMessage, permanentFail, resolveParam, succeeded } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

type Audience = "admins" | "members";

interface Recipient {
  userId: string;
  email: string | null;
}

// Role values are not canonical in storage: legacy rows carry Clerk-style
// 'org:admin' / 'org:owner' / bare 'owner' alongside 'admin' (mirrors
// normalizeOrganizationRole in @sdp/types).
const ELEVATED_ROLES = ["admin", "owner", "org:admin", "org:owner"];

// Resolve who to notify from the rule's `audience` param, live from membership at
// execution time — no preferences table (per-user opt-in/out is the deferred full
// feature). Membership is scoped to the execution's project when the org uses
// project-level membership; members without a project_members row fall back to
// org-level membership so orgs that don't use project membership still resolve.
async function resolveAudience(
  env: Env,
  execution: WorkflowExecutionRow,
  audience: Audience
): Promise<Recipient[]> {
  const roleFilter = audience === "members" ? "" : "AND om.role = ANY(?::text[])";
  const bindings: Array<string | string[]> = [
    execution.project_id,
    execution.organization_id,
    execution.project_id,
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

// 'owner' collapsed into 'admins' intentionally (both are elevated); the catalog/UI
// only offer admins/members.
function parseAudience(value: string | null): Audience {
  return value === "members" ? "members" : "admins";
}

// notify: deliver an in-app notification (and, when email is configured, an email) to a
// per-rule audience. In-app is the durable channel and always works; email is a
// best-effort add-on. A specific `email` param targets one external address (email only).
export async function runNotify(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const title = resolveParam(action, "title") ?? `Workflow: ${execution.trigger_type}`;
  const body =
    resolveParam(action, "message") ??
    `A "${execution.trigger_type}" event triggered an automation on this asset.`;

  // Targeting a specific external email (no in-app row — there's no user to attach it to).
  const specificEmail = resolveParam(action, "email");
  if (specificEmail) {
    if (!isEmailConfigured(env)) {
      return permanentFail("EMAIL_NOT_CONFIGURED");
    }
    try {
      await createTransactionalEmailService(env).send({
        to: [specificEmail],
        subject: title,
        text: body,
      });
      return succeeded({ emailedTo: 1 });
    } catch (error) {
      return { status: "failed", retryable: true, result: {}, error: errorMessage(error) };
    }
  }

  const recipients = await resolveAudience(
    env,
    execution,
    parseAudience(resolveParam(action, "audience"))
  );
  if (recipients.length === 0) {
    // A rule that notifies nobody is a config gap worth surfacing, not a silent success.
    return permanentFail("NO_RECIPIENTS_RESOLVED");
  }

  // One insert round trip; the execution-id dedupe key makes engine/manual retries no-op
  // instead of duplicating every recipient's notification.
  const inserted = await createNotificationsRepository(env).createMany(
    recipients.map((recipient) => ({
      organizationId: execution.organization_id,
      userId: recipient.userId,
      type: "workflow_execution",
      title,
      body,
      resourceType: "token",
      resourceId: execution.token_id,
      params: {
        triggerType: execution.trigger_type,
        actionType: execution.action_type,
        tokenId: execution.token_id,
        workflowId: execution.workflow_id,
        // True when the rule author wrote their own title — the client then renders it
        // verbatim instead of its localized template.
        customTitle: Boolean(resolveParam(action, "title")),
      },
      dedupeKey: `${execution.id}:${recipient.userId}`,
    }))
  );

  // Best-effort email fan-out (does not fail the action — the in-app rows are the
  // truth). Sent per-recipient so addresses are never disclosed across recipients.
  let emailed = 0;
  if (isEmailConfigured(env)) {
    const emailService = createTransactionalEmailService(env);
    const emails = recipients.map((r) => r.email).filter((e): e is string => Boolean(e));
    const sends = await Promise.allSettled(
      emails.map((to) => emailService.send({ to: [to], subject: title, text: body }))
    );
    emailed = sends.filter((s) => s.status === "fulfilled").length;
    for (const send of sends) {
      if (send.status === "rejected") {
        console.error("workflow notify: email send failed", {
          error: errorMessage(send.reason),
        });
      }
    }
  }

  return succeeded({ notified: recipients.length, inserted, emailed });
}
