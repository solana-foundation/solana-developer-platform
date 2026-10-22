import type { DeletedObjectJSON, OrganizationJSON, UserJSON } from "@clerk/backend";
import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import {
  findClerkOrganizationMapping,
  syncClerkOrganization,
} from "@/services/clerk-organization-provisioning.service";
import { verifiedPrimaryEmailFromClerkUser } from "@/services/clerk-users.service";
import { applyStoredRampWebhookEvent } from "@/services/jobs/replay-ramp-webhook-events";
import type { WebhookProcessor } from "@/services/ramps/webhooks/processor";
import {
  parseRampWebhookProvider,
  RAMP_PROVIDER_WEBHOOK_PROCESSOR,
} from "@/services/ramps/webhooks/registry";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

async function findOrganizationMapping(c: AppContext, clerkOrgId: string) {
  const mapping = await findClerkOrganizationMapping(getDb(c.env), clerkOrgId);
  return mapping ? { organization_id: mapping.organizationId, slug: mapping.slug } : null;
}

async function syncOrganization(c: AppContext, data: OrganizationJSON) {
  const synced = await syncClerkOrganization({ db: getDb(c.env), organization: data });
  if (!synced) {
    logIgnoredClerkEvent(c, "organization", data.id);
  }
}

/**
 * Logs a Clerk event SDP does not act on. SDP owns organizations and their
 * memberships (ADR 0012): Clerk's events about them change nothing here, and
 * SDP's own writes to Clerk come back as these same events.
 *
 * @param c - The request context.
 * @param resource - What the event is about.
 * @param clerkId - The Clerk id it names.
 */
function logIgnoredClerkEvent(
  c: AppContext,
  resource: "organization" | "user" | "organization_membership",
  clerkId: string | undefined
) {
  getLogger().info(
    { requestId: c.get("requestId"), resource, clerkId },
    "webhooks: ignored a Clerk event SDP does not act on"
  );
}

async function deleteOrganization(c: AppContext, data: DeletedObjectJSON) {
  if (!data.id) {
    return;
  }

  const mapping = await findOrganizationMapping(c, data.id);
  if (!mapping) {
    return;
  }

  const db = getDb(c.env);

  await db.batch([
    db
      .prepare(
        `UPDATE organizations
         SET status = 'deleted', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(mapping.organization_id),
    // A pending invitation is a way back in: accepting one re-activates a
    // removed membership in this organization. Invitations lock before
    // memberships, the same order sign-in admission takes them, so a
    // concurrent admission cannot deadlock the deletion.
    db
      .prepare(
        "UPDATE invitations SET status = 'revoked' WHERE organization_id = ? AND status = 'pending'"
      )
      .bind(mapping.organization_id),
    db
      .prepare("UPDATE organization_members SET status = 'removed' WHERE organization_id = ?")
      .bind(mapping.organization_id),
    db
      .prepare(
        `UPDATE api_keys
         SET status = 'revoked', revoked_at = datetime('now')
         WHERE organization_id = ? AND status = 'active'`
      )
      .bind(mapping.organization_id),
  ]);
}

async function ensureUserMapping(
  c: AppContext,
  user: { id: string; email: string; name?: string | null }
): Promise<string> {
  const db = getDb(c.env);
  const email = user.email.toLowerCase();
  const existing = await db
    .prepare(
      `SELECT aui.user_id, u.email
       FROM auth_user_identities aui
       JOIN users u ON u.id = aui.user_id
       WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
    )
    .bind(user.id)
    .first<{ user_id: string; email: string }>();

  if (existing?.user_id) {
    const updates = ["status = 'active'"];
    const params: (string | null)[] = [];
    let identityEmail = existing.email;

    const owner = await db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();

    if (!owner || owner.id === existing.user_id) {
      updates.push("email = ?");
      params.push(email);
      identityEmail = email;
    }

    if (user.name) {
      updates.push("name = ?");
      params.push(user.name);
    }

    params.push(existing.user_id);
    await db.batch([
      db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...params),
      db
        .prepare(
          `UPDATE auth_user_identities
           SET email = ?, updated_at = datetime('now')
           WHERE provider = 'clerk' AND provider_user_id = ?`
        )
        .bind(identityEmail, user.id),
    ]);

    return existing.user_id;
  }

  const localUser = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  const userId = localUser?.id ?? `usr_${crypto.randomUUID()}`;

  if (!localUser) {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, email_verified, status)
         VALUES (?, ?, ?, 1, 'active')`
      )
      .bind(userId, email, user.name)
      .run();
  }

  await db
    .prepare(
      `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
       VALUES (?, 'clerk', ?, ?, ?)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = datetime('now')`
    )
    .bind(`aui_${crypto.randomUUID()}`, user.id, userId, email)
    .run();

  return userId;
}

async function syncUser(c: AppContext, data: UserJSON) {
  const email = verifiedPrimaryEmailFromClerkUser(data);
  if (!email) {
    return;
  }
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
  await ensureUserMapping(c, {
    id: data.id,
    email,
    name: fullName || data.username,
  });
}

export const handleRampProviderWebhook = async (c: AppContext, environment: SdpEnvironment) => {
  const provider = parseRampWebhookProvider(c.req.param("provider"));
  const rawBody = await c.req.raw.text();
  const processor: WebhookProcessor<unknown> = RAMP_PROVIDER_WEBHOOK_PROCESSOR[provider];

  await processor.verify({
    env: c.env as unknown as Record<string, string | undefined>,
    environment,
    headers: c.req.raw.headers,
    rawBody,
    requestUrl: c.req.url,
  });
  const { row: stored, inserted } = await createPostgresRampWebhookEventsRepository(
    getDb(c.env)
  ).insertVerifiedEvent({
    provider: processor.provider,
    environment,
    rawBody,
    providerEventId: processor.eventId(rawBody),
  });

  // Ack immediately and apply in the background: a slow settlement write must
  // not delay the 2xx. The apply discharges the stored row on success and
  // records the failure on it otherwise, leaving replay to retry.
  // The apply records its own failures on the row; this catch is only for the
  // recording itself failing (the DB going away mid-pass). The row is still
  // pending then, so the replay job picks it up — log and move on.
  if (inserted)
    c.executionCtx.waitUntil(
      applyStoredRampWebhookEvent(c.env, stored, stored.attempts + 1).catch((error) =>
        getLogger().error(
          {
            provider: processor.provider,
            webhook_event_id: stored.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[ramp webhook] background apply failed to record its outcome"
        )
      )
    );

  return success(c, {
    received: true,
    provider: processor.provider,
    environment,
  });
};

export const handleClerkWebhook = async (c: AppContext) => {
  const secret = c.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError("INTERNAL_ERROR", "CLERK_WEBHOOK_SECRET is required");
  }

  let event: WebhookEvent;
  try {
    event = await verifyWebhook(c.req.raw, { signingSecret: secret });
  } catch (err) {
    throw new AppError("UNAUTHORIZED", "Invalid webhook signature", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  switch (event.type) {
    case "organization.created":
    case "organization.updated":
      await syncOrganization(c, event.data);
      break;
    case "organization.deleted":
      await deleteOrganization(c, event.data);
      break;
    case "user.created":
    case "user.updated":
      await syncUser(c, event.data);
      break;
    case "user.deleted":
      logIgnoredClerkEvent(c, "user", event.data.id);
      break;
    case "organizationMembership.created":
    case "organizationMembership.updated":
    case "organizationMembership.deleted":
      logIgnoredClerkEvent(c, "organization_membership", event.data.id);
      break;
    default:
      break;
  }

  return success(c, { received: true });
};
