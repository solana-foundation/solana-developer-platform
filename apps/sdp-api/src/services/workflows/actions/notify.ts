import { getDb } from "@/db";
import { createNotificationsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { createTransactionalEmailService, isEmailConfigured } from "@/services/email";
import type { Env } from "@/types/env";
import { humanizeWorkflowKey } from "../labels";
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

// The `email` param addresses one mailbox directly, with an operator-controlled subject
// and body, from the org's verified sending domain — i.e. exactly the shape of an open
// relay. Restricting delivery to addresses that already belong to an active member of
// this organization keeps the escape hatch (alerting a specific admin) without letting a
// rule mail arbitrary third parties.
async function isOrganizationMemberEmail(
  env: Env,
  organizationId: string,
  email: string
): Promise<boolean> {
  const row = await getDb(env)
    .prepare(
      `SELECT 1 AS ok
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ? AND om.status = 'active'
          AND LOWER(u.email) = LOWER(?)
        LIMIT 1`
    )
    .bind(organizationId, email)
    .first<{ ok: number }>();
  return Boolean(row);
}

// notify: deliver an in-app notification (and, when email is configured, an email) to a
// per-rule audience. In-app is the durable channel and always works; email is a
// best-effort add-on. A specific `email` param targets one external address (email only).
export async function runNotify(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  // Humanized for the server-composed defaults (email subject/body + the stored fallback).
  // The dashboard re-localizes in-app rows from `params.triggerType`, so a raw key never
  // reaches a reader on either channel.
  const triggerLabel = humanizeWorkflowKey(execution.trigger_type);
  const title = resolveParam(action, "title") ?? `Automation ran: ${triggerLabel}`;
  const body =
    resolveParam(action, "message") ??
    `A ${triggerLabel} event triggered an automation on this asset.`;

  // Targeting one specific mailbox (no in-app row — there's no user to attach it to).
  const specificEmail = resolveParam(action, "email");
  if (specificEmail) {
    if (!isEmailConfigured(env)) {
      return permanentFail("EMAIL_NOT_CONFIGURED");
    }
    if (!(await isOrganizationMemberEmail(env, execution.organization_id, specificEmail))) {
      return permanentFail("EMAIL_NOT_ORG_MEMBER");
    }
    try {
      await createTransactionalEmailService(env).send({
        to: [specificEmail],
        subject: title,
        text: body,
      });
      return succeeded({ emailedTo: 1 });
    } catch (error) {
      // A rejected address or a malformed payload won't fix itself; only transport
      // failures deserve the retry budget.
      const message = errorMessage(error);
      return /\b4\d\d\b|invalid|rejected/i.test(message)
        ? permanentFail(message)
        : { status: "failed", retryable: true, result: {}, error: message };
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
        getLogger().error(
          { error: errorMessage(send.reason) },
          "workflow notify: email send failed"
        );
      }
    }
  }

  return succeeded({ notified: recipients.length, inserted, emailed });
}
