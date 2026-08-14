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
  createCounterpartiesRepository,
  createNotificationDeliveriesRepository,
  createNotificationPreferencesRepository,
  createNotificationsRepository,
  type NotificationDeliveriesRepository,
} from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { publishInboxNudges } from "@/runtime/pubsub-redis";
import {
  createTransactionalEmailService,
  isEmailConfigured,
  type TransactionalEmailDeliveryResult,
  TransactionalEmailError,
  type TransactionalEmailMessage,
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

// Bounded fan-out concurrency: protects the pg pool (max 10 connections shared with
// live traffic) and stays near Resend's rate limit — a whole-org audience queues
// behind the cap instead of stampeding.
const EMAIL_SEND_CONCURRENCY = 4;
const TRANSIENT_SEND_RETRY_DELAY_MS = 1_500;

function isTransientSendError(error: unknown): boolean {
  if (!(error instanceof TransactionalEmailError)) return false;
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

// One delayed in-process retry for provider backpressure (429/5xx): most producers are
// env-based with no external re-drive, so a rate-limited send would otherwise land as
// a `failed` claim that nothing ever reclaims.
async function sendWithOneRetry(
  emailService: TransactionalEmailService,
  message: TransactionalEmailMessage
): Promise<TransactionalEmailDeliveryResult> {
  try {
    return await emailService.send(message);
  } catch (error) {
    if (!isTransientSendError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_SEND_RETRY_DELAY_MS));
    return emailService.send(message);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as T;
      try {
        results[index] = { status: "fulfilled", value: await task(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Send one already-claimed email and settle its claim. Throws on send failure (after
// marking the claim reclaimable) so the caller can count and log it.
async function deliverClaimedEmail(params: {
  deliveries: NotificationDeliveriesRepository;
  emailService: TransactionalEmailService;
  claimId: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  let delivery: TransactionalEmailDeliveryResult;
  try {
    delivery = await sendWithOneRetry(params.emailService, {
      to: [params.recipient],
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.deliveries
      .markFailed({ id: params.claimId, error: message })
      .catch(() => undefined);
    throw error;
  }
  // The mail is delivered; a bookkeeping failure here must NOT mark the claim `failed`
  // (that's the reclaimable state — the next producer run would send a duplicate).
  // Swallowed, the claim stays `pending`, which blocks re-sends: the at-most-once side.
  await params.deliveries
    .markSent({ id: params.claimId, providerMessageId: delivery.messageId })
    .catch((error) =>
      getLogger().warn(
        { error: error instanceof Error ? error.message : String(error) },
        "notification email sent but markSent failed; claim left pending"
      )
    );
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
  // One batched claim round-trip for the whole fan-out; recipients whose key is
  // already owned (sent/pending — a retried producer) simply drop out here.
  const claims = await deliveries.claimMany(
    recipients.map((recipient) => ({
      organizationId: input.organizationId,
      userId: recipient.userId,
      channel: "email" as const,
      recipient: recipient.email,
      dedupeKey: `${input.eventKey}:${recipient.userId}`,
    }))
  );
  const claimed = recipients.flatMap((recipient) => {
    const claimId = claims.get(`${input.eventKey}:${recipient.userId}`);
    return claimId ? [{ recipient, claimId }] : [];
  });
  const sends = await mapWithConcurrency(claimed, EMAIL_SEND_CONCURRENCY, (entry) =>
    deliverClaimedEmail({
      deliveries,
      emailService,
      claimId: entry.claimId,
      recipient: entry.recipient.email,
      subject: input.emailSubject ?? input.title,
      html,
      text,
    })
  );
  let emailed = 0;
  for (const send of sends) {
    if (send.status === "fulfilled") {
      emailed += 1;
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
// in-app recipient — a dedupe-skipped subset just refetches a stable count. One
// pipelined Redis exchange for the whole fan-out.
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
    await publishInboxNudges(
      env,
      organizationId,
      recipients.map((recipient) => ({
        userId: recipient.userId,
        nudge: { unread: counts.get(recipient.userId) ?? 0, ts } satisfies NotificationInboxNudge,
      }))
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

    // Nudge BEFORE the email fan-out: the in-app rows are durable at this point, and
    // realtime latency must never be gated on Resend round-trips (the SSE path would
    // otherwise be slower than the 60s poll it exists to beat). Fires only when
    // something new landed — a retry inserts 0 → no nudges.
    if (inserted > 0 && inAppRecipients.length > 0) {
      await publishNudges(env, input.organizationId, inAppRecipients);
    }

    const emailed = await sendEmailFanout(env, input, emailRecipients);

    return { resolved: recipients.length, inserted, emailed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error({ error: message, type: input.type }, "notification dispatch failed");
    return { resolved: 0, inserted: 0, emailed: 0, error: message };
  }
}

export interface CounterpartyEmailInput {
  organizationId: string;
  // Counterparties are project-scoped rows; producers pass the ids from the trusted
  // domain record (transfer / kyc wallet), never request input.
  projectId: string;
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
    // Through the tenant-scoped repository, never raw SQL: counterparty PII (the
    // email) lives encrypted in pii_encrypted — the plain column is only a
    // migration-phase shadow — and the scope pins the lookup to the producer's org.
    const scope = createTenantScope({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    const counterparty = await createCounterpartiesRepository(env, scope).getCounterpartyById({
      counterpartyId: input.counterpartyId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (counterparty?.status !== "active") {
      return { emailed: 0 };
    }
    const recipient = counterparty.email.trim();
    if (!recipient) {
      // No contact email on record — a clean no-op, not an error.
      return { emailed: 0 };
    }
    const organization = await getDb(env)
      .prepare(`SELECT name, slug FROM organizations WHERE id = ?`)
      .bind(input.organizationId)
      .first<{ name: string | null; slug: string | null }>();
    // The footer's entire job is telling an external recipient WHO sent this — a note
    // that names nobody fails the requirement, so an unnameable org sends nothing.
    // (No replyTo either: organizations carry no contact email column to point at.)
    const orgName = organization?.name?.trim() || organization?.slug?.trim();
    if (!orgName) {
      getLogger().warn(
        { organizationId: input.organizationId, type: input.type },
        "counterparty receipt skipped: organization has no usable name"
      );
      return { emailed: 0 };
    }

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
    let delivery: { messageId: string | null };
    try {
      delivery = await sendWithOneRetry(createTransactionalEmailService(env), {
        to: [recipient],
        subject: input.emailSubject ?? input.title,
        html,
        text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliveries.markFailed({ id: claimId, error: message }).catch(() => undefined);
      getLogger().error({ error: message }, "counterparty receipt email failed");
      return { emailed: 0, error: message };
    }
    // Delivered; a markSent failure must not make the claim reclaimable (see
    // sendClaimedEmail) — left `pending`, replays stay blocked.
    await deliveries
      .markSent({ id: claimId, providerMessageId: delivery.messageId })
      .catch((error) =>
        getLogger().warn(
          { error: error instanceof Error ? error.message : String(error) },
          "counterparty receipt sent but markSent failed; claim left pending"
        )
      );
    return { emailed: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error({ error: message, type: input.type }, "counterparty dispatch failed");
    return { emailed: 0, error: message };
  }
}
