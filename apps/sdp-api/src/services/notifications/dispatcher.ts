// The notification dispatcher: one fan-out pipeline for every producer.
//
//   resolve audience → drop excluded (no self-notifications) → per-channel preference
//   filter → in-app rows (idempotent on `${eventKey}:${userId}`) → per-recipient email
//   behind a delivery claim (idempotent on the same key) → realtime nudge per recipient.
//
// Idempotency falls out of the keys: a retried producer inserts 0 rows, claims 0
// deliveries, publishes 0 nudges. NEVER throws — internal failures are logged and
// reflected in `error`, so callers on the hot path (webhooks, engine) can fire and
// forget while callers that care (the notify action) can still distinguish "nobody to
// notify" from "the pipeline broke".

import {
  type NotificationInboxNudge,
  type NotificationType,
  notificationCategoryFor,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  createNotificationDeliveriesRepository,
  createNotificationPreferencesRepository,
  createNotificationsRepository,
  type NotificationDeliveriesRepository,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { publishInboxNudge } from "@/runtime/pubsub-redis";
import {
  createTransactionalEmailService,
  isEmailConfigured,
  type TransactionalEmailService,
} from "@/services/email";
import { renderNotificationEmail } from "@/services/email/templates/notification";
import type { Env } from "@/types/env";
import {
  type NotificationAudience,
  type NotificationRecipient,
  resolveOrgAudience,
  resolveOrgMembersByIds,
} from "./audience";
import { managePreferencesLink, resourceLink } from "./resource-links";

export interface NotificationDispatchInput {
  organizationId: string;
  projectId?: string | null;
  type: NotificationType;
  // Idempotency root, unique per real-world occurrence (entity-id-first, e.g.
  // `member_invited:<invitationId>`). In-app dedupe key = `${eventKey}:${userId}`.
  eventKey: string;
  title: string;
  body?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  // Structured facts for client-side (localized) rendering.
  params?: Record<string, unknown>;
  // Who: a role audience (default "admins") or explicit member ids — not both.
  audience?: NotificationAudience;
  userIds?: string[];
  // Actor exclusion: the person who performed the action isn't told about it.
  excludeUserIds?: string[];
  emailSubject?: string;
  // Email CTA override; defaults to the resource deep link.
  ctaUrl?: string | null;
}

export interface NotificationDispatchResult {
  // Recipients after audience resolution + exclusion, before preference filtering.
  resolved: number;
  // New in-app rows (0 on a producer retry).
  inserted: number;
  // Emails actually sent by this call.
  emailed: number;
  // Set when the pipeline itself failed (as opposed to resolving nobody).
  error?: string;
}

async function sendClaimedEmail(params: {
  deliveries: NotificationDeliveriesRepository;
  emailService: TransactionalEmailService;
  organizationId: string;
  userId: string | null;
  recipient: string;
  dedupeKey: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const claimId = await params.deliveries.claim({
    organizationId: params.organizationId,
    userId: params.userId,
    channel: "email",
    recipient: params.recipient,
    dedupeKey: params.dedupeKey,
  });
  if (!claimId) {
    // Already sent (or in flight) for this event — a retried producer lands here.
    return false;
  }
  try {
    const delivery = await params.emailService.send({
      to: [params.recipient],
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    await params.deliveries.markSent({ id: claimId, providerMessageId: delivery.messageId });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.deliveries.markFailed({ id: claimId, error: message }).catch(() => undefined);
    throw error;
  }
}

async function resolveRecipients(
  env: Env,
  input: NotificationDispatchInput
): Promise<NotificationRecipient[]> {
  const recipients =
    input.userIds && input.userIds.length > 0
      ? await resolveOrgMembersByIds(env, {
          organizationId: input.organizationId,
          userIds: input.userIds,
        })
      : await resolveOrgAudience(env, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          audience: input.audience ?? "admins",
        });
  if (!input.excludeUserIds || input.excludeUserIds.length === 0) {
    return recipients;
  }
  const excluded = new Set(input.excludeUserIds);
  return recipients.filter((recipient) => !excluded.has(recipient.userId));
}

async function insertInAppRows(
  env: Env,
  input: NotificationDispatchInput,
  recipients: NotificationRecipient[]
): Promise<number> {
  if (recipients.length === 0) {
    return 0;
  }
  return createNotificationsRepository(env).createMany(
    recipients.map((recipient) => ({
      organizationId: input.organizationId,
      userId: recipient.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      params: input.params ?? null,
      dedupeKey: `${input.eventKey}:${recipient.userId}`,
    }))
  );
}

// Per-recipient sends so addresses are never disclosed across recipients; each behind
// its own claim so a partial failure retries only the failed sends.
async function sendEmailFanout(
  env: Env,
  input: NotificationDispatchInput,
  recipients: Array<NotificationRecipient & { email: string }>
): Promise<number> {
  if (recipients.length === 0 || !isEmailConfigured(env)) {
    return 0;
  }
  const emailService = createTransactionalEmailService(env);
  const deliveries = createNotificationDeliveriesRepository(env);
  const { html, text } = await renderNotificationEmail({
    title: input.title,
    body: input.body,
    ctaUrl:
      input.ctaUrl ??
      resourceLink(env, {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        type: input.type,
      }),
    managePreferencesUrl: managePreferencesLink(env),
  });
  const sends = await Promise.allSettled(
    recipients.map((recipient) =>
      sendClaimedEmail({
        deliveries,
        emailService,
        organizationId: input.organizationId,
        userId: recipient.userId,
        recipient: recipient.email,
        dedupeKey: `${input.eventKey}:${recipient.userId}`,
        subject: input.emailSubject ?? input.title,
        html,
        text,
      })
    )
  );
  let emailed = 0;
  for (const send of sends) {
    if (send.status === "fulfilled") {
      if (send.value) emailed += 1;
    } else {
      getLogger().error(
        { error: send.reason instanceof Error ? send.reason.message : String(send.reason) },
        "notification email send failed"
      );
    }
  }
  return emailed;
}

// Realtime is best-effort; the bell's polling covers a missed nudge. Nudge every
// in-app recipient — a dedupe-skipped subset just refetches a stable count.
async function publishNudges(
  env: Env,
  organizationId: string,
  recipients: NotificationRecipient[]
): Promise<void> {
  try {
    const counts = await createNotificationsRepository(env).countUnreadForUsers({
      organizationId,
      userIds: recipients.map((r) => r.userId),
    });
    const ts = new Date().toISOString();
    await Promise.allSettled(
      recipients.map((recipient) => {
        const nudge: NotificationInboxNudge = {
          unread: counts.get(recipient.userId) ?? 0,
          ts,
        };
        return publishInboxNudge(env, organizationId, recipient.userId, nudge);
      })
    );
  } catch (error) {
    getLogger().warn(
      { error: error instanceof Error ? error.message : String(error) },
      "notification nudge publish failed"
    );
  }
}

export async function dispatchNotification(
  env: Env,
  input: NotificationDispatchInput
): Promise<NotificationDispatchResult> {
  try {
    const recipients = await resolveRecipients(env, input);
    if (recipients.length === 0) {
      return { resolved: 0, inserted: 0, emailed: 0 };
    }

    const category = notificationCategoryFor(input.type);
    const preferences = createNotificationPreferencesRepository(env);
    const userIds = recipients.map((recipient) => recipient.userId);
    const [inAppDisabled, emailDisabled] = await Promise.all([
      preferences.listDisabledUserIds({
        organizationId: input.organizationId,
        category,
        channel: "in_app",
        userIds,
      }),
      preferences.listDisabledUserIds({
        organizationId: input.organizationId,
        category,
        channel: "email",
        userIds,
      }),
    ]);

    const inAppRecipients = recipients.filter((r) => !inAppDisabled.has(r.userId));
    const emailRecipients = recipients.filter(
      (r): r is NotificationRecipient & { email: string } =>
        !emailDisabled.has(r.userId) && Boolean(r.email)
    );

    const inserted = await insertInAppRows(env, input, inAppRecipients);
    const emailed = await sendEmailFanout(env, input, emailRecipients);

    // Nudges fire only when something new landed (a retry inserts 0 → no nudges).
    if (inserted > 0 && inAppRecipients.length > 0) {
      await publishNudges(env, input.organizationId, inAppRecipients);
    }

    return { resolved: recipients.length, inserted, emailed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error({ error: message, type: input.type }, "notification dispatch failed");
    return { resolved: 0, inserted: 0, emailed: 0, error: message };
  }
}

export interface CounterpartyEmailInput {
  organizationId: string;
  counterpartyId: string;
  type: NotificationType;
  eventKey: string;
  title: string;
  body?: string | null;
  emailSubject?: string;
}

export interface CounterpartyEmailResult {
  emailed: number;
  error?: string;
}

// External counterparty receipts: email-only, no in-app row, no preferences — the
// recipient is not a platform user. This is a transactional receipt to a party of the
// transaction (not marketing), sent with an explicit who-and-why footer. Deliberately
// NOT a general external-email path: recipients come only from the org's own
// counterparty records, keeping the anti-open-relay stance intact.
export async function dispatchCounterpartyEmail(
  env: Env,
  input: CounterpartyEmailInput
): Promise<CounterpartyEmailResult> {
  try {
    if (!isEmailConfigured(env)) {
      return { emailed: 0 };
    }
    const counterparty = await getDb(env)
      .prepare(`SELECT email, name FROM counterparties WHERE id = ? AND organization_id = ?`)
      .bind(input.counterpartyId, input.organizationId)
      .first<{ email: string | null; name: string | null }>();
    const recipient = counterparty?.email?.trim();
    if (!recipient) {
      // No contact email on record — a clean no-op, not an error.
      return { emailed: 0 };
    }
    const organization = await getDb(env)
      .prepare(`SELECT name FROM organizations WHERE id = ?`)
      .bind(input.organizationId)
      .first<{ name: string | null }>();
    const orgName = organization?.name?.trim() || "your counterparty";

    const claimId = await createNotificationDeliveriesRepository(env).claim({
      organizationId: input.organizationId,
      userId: null,
      channel: "email",
      recipient,
      dedupeKey: `${input.eventKey}:counterparty:${input.counterpartyId}`,
    });
    if (!claimId) {
      return { emailed: 0 };
    }

    const { html, text } = await renderNotificationEmail({
      title: input.title,
      body: input.body,
      externalRecipientNote: `You are receiving this because ${orgName} processed a transaction involving your account on the Solana Developer Platform.`,
    });
    const deliveries = createNotificationDeliveriesRepository(env);
    try {
      const delivery = await createTransactionalEmailService(env).send({
        to: [recipient],
        subject: input.emailSubject ?? input.title,
        html,
        text,
      });
      await deliveries.markSent({ id: claimId, providerMessageId: delivery.messageId });
      return { emailed: 1 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliveries.markFailed({ id: claimId, error: message }).catch(() => undefined);
      getLogger().error({ error: message }, "counterparty receipt email failed");
      return { emailed: 0, error: message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error({ error: message, type: input.type }, "counterparty dispatch failed");
    return { emailed: 0, error: message };
  }
}
