import { getDb } from "@/db";
import { createNotificationsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { createTransactionalEmailService, isEmailConfigured } from "@/services/email";
import type { Env } from "@/types/env";
import { errorMessage, permanentFail, resolveParam, succeeded } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

type Audience = "admins" | "members" | "owner";

interface Recipient {
  userId: string;
  email: string | null;
}

// Resolve who to notify from the rule's `audience` param, live from org membership — no
// preferences table (per-user opt-in/out is the deferred full feature). "admins"/"owner"
// → elevated members; "members" → all active members.
async function resolveAudience(
  env: Env,
  organizationId: string,
  audience: Audience
): Promise<Recipient[]> {
  const roleFilter = audience === "members" ? "" : "AND om.role IN ('admin', 'owner')";
  const result = await getDb(env)
    .prepare(
      `SELECT u.id AS user_id, u.email
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ? AND om.status = 'active' ${roleFilter}`
    )
    .bind(organizationId)
    .all<{ user_id: string; email: string | null }>();
  return result.results.map((row) => ({ userId: row.user_id, email: row.email }));
}

function parseAudience(value: string | null): Audience {
  if (value === "members" || value === "owner") {
    return value;
  }
  return "admins";
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
    execution.organization_id,
    parseAudience(resolveParam(action, "audience"))
  );

  const notifications = createNotificationsRepository(env);
  for (const recipient of recipients) {
    await notifications.create({
      organizationId: execution.organization_id,
      userId: recipient.userId,
      type: "workflow_execution",
      title,
      body,
      resourceType: "token",
      resourceId: execution.token_id,
    });
  }

  // Best-effort email fan-out (does not fail the action — the in-app rows are the truth).
  let emailed = 0;
  if (isEmailConfigured(env)) {
    const emails = recipients.map((r) => r.email).filter((e): e is string => Boolean(e));
    if (emails.length > 0) {
      try {
        await createTransactionalEmailService(env).send({ to: emails, subject: title, text: body });
        emailed = emails.length;
      } catch (error) {
        console.error("workflow notify: email send failed", { error: errorMessage(error) });
      }
    }
  }

  return succeeded({ notified: recipients.length, emailed });
}
