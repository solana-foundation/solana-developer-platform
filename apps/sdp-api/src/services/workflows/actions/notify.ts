import type { WorkflowExecutionRow } from "@/db/repositories";
import {
  createNotificationDeliveriesRepository,
  createNotificationPreferencesRepository,
} from "@/db/repositories";
import {
  createTransactionalEmailService,
  isEmailConfigured,
  TransactionalEmailError,
} from "@/services/email";
import { renderNotificationEmail } from "@/services/email/templates/notification";
import {
  dispatchNotification,
  findOrganizationMemberByEmail,
  managePreferencesLink,
} from "@/services/notifications";
import type { Env } from "@/types/env";
import { humanizeWorkflowKey } from "../labels";
import { errorMessage, permanentFail, resolveParam, succeeded } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

type Audience = "admins" | "members";

// 'owner' collapsed into 'admins' intentionally (both are elevated); the catalog/UI
// only offer admins/members.
function parseAudience(value: string | null): Audience {
  return value === "members" ? "members" : "admins";
}

// Retry only what a retry can fix. Typed classification — never regex the message
// string: transport errors routinely embed 4xx-looking substrings (`ECONNREFUSED
// 10.0.0.5:465`), and config errors carry fixed English text that no pattern can
// reliably separate from provider rejections. Exported for its unit test.
export function isPermanentEmailError(error: unknown): boolean {
  if (!(error instanceof TransactionalEmailError)) {
    // Unknown shape (network, DNS, undici) — transport-flavored, worth the budget.
    return false;
  }
  if (error.code === "misconfigured" || error.code === "invalid_message") {
    return true;
  }
  // Provider 4xx = rejected payload/recipient, except 429 which is pure backpressure.
  return (
    error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429
  );
}

// notify: deliver an in-app notification (and, when email is configured, an email) to a
// per-rule audience via the shared dispatcher — per-user preferences apply to both
// channels. In-app is the durable channel; email is a best-effort add-on. A specific
// `email` param targets one mailbox directly (email only, still org-member-guarded).
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

  // Targeting one specific mailbox (no in-app row — the row belongs to the inbox, and
  // this branch is about reaching an address). Trimmed: the member lookup compares
  // exactly, and a rule author's stray padding must not read as "not an org member".
  const specificEmail = resolveParam(action, "email")?.trim();
  if (specificEmail) {
    if (!isEmailConfigured(env)) {
      return permanentFail("EMAIL_NOT_CONFIGURED");
    }
    // Anti-open-relay guard: the address must belong to an active member of this org.
    const member = await findOrganizationMemberByEmail(
      env,
      execution.organization_id,
      specificEmail
    );
    if (!member) {
      return permanentFail("EMAIL_NOT_ORG_MEMBER");
    }
    // The mailbox owner's email-channel preference applies here too — an opted-out
    // member staying unmailed is the rule working, not a failure.
    const emailDisabled = await createNotificationPreferencesRepository(env).listDisabledUserIds({
      organizationId: execution.organization_id,
      category: "workflows",
      channel: "email",
      userIds: [member.userId],
    });
    if (emailDisabled.has(member.userId)) {
      return succeeded({ emailedTo: 0, skippedByPreference: true });
    }

    // Delivery claim: a manual retry of this execution must not re-send the email.
    const deliveries = createNotificationDeliveriesRepository(env);
    const claimId = await deliveries.claim({
      organizationId: execution.organization_id,
      userId: member.userId,
      channel: "email",
      recipient: specificEmail,
      dedupeKey: `${execution.id}:email:${specificEmail.toLowerCase()}`,
    });
    if (!claimId) {
      return succeeded({ emailedTo: 0, alreadyDelivered: true });
    }
    let delivery: { messageId: string | null };
    try {
      const { html, text } = await renderNotificationEmail({
        title,
        body,
        managePreferencesUrl: managePreferencesLink(env),
      });
      delivery = await createTransactionalEmailService(env).send({
        to: [specificEmail],
        subject: title,
        html,
        text,
      });
    } catch (error) {
      // A rejected address or a malformed payload won't fix itself; only transport
      // failures deserve the retry budget. The failed claim is reclaimable, so a retry
      // re-attempts the send.
      const message = errorMessage(error);
      await deliveries.markFailed({ id: claimId, error: message }).catch(() => undefined);
      return isPermanentEmailError(error)
        ? permanentFail(message)
        : { status: "failed", retryable: true, result: {}, error: message };
    }
    // The mail is delivered; a markSent failure must not mark the claim `failed` — the
    // engine would classify it retryable, reclaim, and send a duplicate. Left
    // `pending`, the claim keeps blocking re-sends.
    await deliveries
      .markSent({ id: claimId, providerMessageId: delivery.messageId })
      .catch(() => undefined);
    return succeeded({ emailedTo: 1 });
  }

  // Audience fan-out through the shared dispatcher: in-app rows dedupe on the execution
  // id, email sends sit behind delivery claims, per-user preferences filter both
  // channels, and recipients get a realtime nudge.
  const result = await dispatchNotification(env, {
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    type: "workflow_execution",
    // Bare execution id (no type prefix) so rows shipped before the dispatcher existed
    // keep their dedupe keys. Collision-safe only because execution ids are
    // `workflow_execution_<uuid>` — the id format carries what the prefix convention
    // does elsewhere.
    eventKey: execution.id,
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
    audience: parseAudience(resolveParam(action, "audience")),
  });

  if (result.error) {
    // The pipeline itself broke (DB/render) — that's transient, not a config gap.
    return { status: "failed", retryable: true, result: {}, error: result.error };
  }
  if (result.resolved === 0) {
    // A rule that notifies nobody is a config gap worth surfacing, not a silent success.
    return permanentFail("NO_RECIPIENTS_RESOLVED");
  }
  return succeeded({
    notified: result.resolved,
    inserted: result.inserted,
    emailed: result.emailed,
  });
}
