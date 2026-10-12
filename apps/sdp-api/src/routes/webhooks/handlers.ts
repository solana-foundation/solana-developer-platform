import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserDeletedJSON,
  UserJSON,
} from "@clerk/backend";
import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";
import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { refreshApiKeyCache } from "@/lib/api-key-cache";
import { mapClerkRoleToOrgRole } from "@/lib/clerk-role";
import { AppError } from "@/lib/errors";
import {
  revokePendingInvitationsForDeletedUser,
  revokePendingInvitationsForOrganization,
  revokePendingInvitationsForUser,
} from "@/lib/invitations";
import { success } from "@/lib/response";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import {
  ensureClerkOrganizationMapping,
  findClerkOrganizationMapping,
  syncClerkOrganization,
} from "@/services/clerk-organization-provisioning.service";
import {
  ClerkUsersService,
  verifiedPrimaryEmailFromClerkUser,
} from "@/services/clerk-users.service";
import { applyStoredRampWebhookEvent } from "@/services/jobs/replay-ramp-webhook-events";
import { admitOrganizationMember } from "@/services/organization-membership-admission.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";
import type { WebhookProcessor } from "./ramps/processor";
import { parseRampWebhookProvider, RAMP_PROVIDER_WEBHOOK_PROCESSOR } from "./ramps/registry";

type AppContext = Context<{ Bindings: Env }>;

async function findOrganizationMapping(c: AppContext, clerkOrgId: string) {
  const mapping = await findClerkOrganizationMapping(getDb(c.env), clerkOrgId);
  return mapping ? { organization_id: mapping.organizationId, slug: mapping.slug } : null;
}

async function ensureOrganizationMapping(c: AppContext, org: OrganizationJSON): Promise<string> {
  const mapping = await ensureClerkOrganizationMapping({
    env: c.env,
    db: getDb(c.env),
    organization: org,
  });
  return mapping.organizationId;
}

async function syncOrganization(c: AppContext, data: OrganizationJSON) {
  await syncClerkOrganization({
    env: c.env,
    db: getDb(c.env),
    organization: data,
  });
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

  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE organizations
         SET status = 'deleted', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(mapping.organization_id)
      .run();
    await revokePendingInvitationsForOrganization(tx, mapping.organization_id);
    await tx
      .prepare("UPDATE organization_members SET status = 'removed' WHERE organization_id = ?")
      .bind(mapping.organization_id)
      .run();
    await tx
      .prepare(
        `UPDATE api_keys
         SET status = 'revoked', revoked_at = datetime('now')
         WHERE organization_id = ? AND status = 'active'`
      )
      .bind(mapping.organization_id)
      .run();
  });

  // Everything below is post-commit, and each effect is isolated so that one
  // throwing cannot skip the others — every one of them is what stops a live
  // credential. Failures are collected and rethrown at the end so the
  // webhook 500s and Clerk redelivers (the whole handler is idempotent).
  const failures: unknown[] = [];

  // The hashes are queried AFTER the revocation batch commits: a key created
  // concurrently with this webhook still gets revoked by it, and a pre-batch
  // snapshot would miss that key, leaving its cached credentials active for
  // the full TTL. Webhooks are a KV-free path (no c.var.kv), so the store
  // set is built directly — it shares the process-wide Redis client.
  try {
    const orgKeyHashes = await db
      .prepare("SELECT key_hash FROM api_keys WHERE organization_id = ?")
      .bind(mapping.organization_id)
      .all<{ key_hash: string }>();

    const apiKeysKV = createKVStoreSet(c.env).apiKeys;
    const cacheRefreshes = await Promise.allSettled(
      (orgKeyHashes.results ?? []).map((row) => refreshApiKeyCache(db, apiKeysKV, row.key_hash))
    );

    // A rejected refresh and one that resolved false (CAS contention left a
    // possibly-stale entry cached) are equally unresolved.
    const failedRefreshes: unknown[] = [];
    for (const result of cacheRefreshes) {
      if (result.status === "rejected") {
        failedRefreshes.push(result.reason);
      } else if (!result.value) {
        failedRefreshes.push(new Error("api key cache refresh remained contended"));
      }
    }
    if (failedRefreshes.length > 0) {
      getLogger().error(
        { errors: failedRefreshes },
        "Failed to invalidate cached API keys after webhook organization deletion"
      );
      failures.push(...failedRefreshes);
    }
  } catch (error) {
    getLogger().error(
      { error },
      "Failed to enumerate API keys after webhook organization deletion"
    );
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Organization was deleted but some credentials could not be invalidated yet; Clerk redelivery and the reconciliation job repair them"
    );
  }
}

async function resolveVerifiedUserEmail(env: Env, userId: string): Promise<string | null> {
  const user = await new ClerkUsersService(env).getUser(userId);
  return verifiedPrimaryEmailFromClerkUser(user);
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
    const updates: string[] = [];
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
    const identityUpdate = db
      .prepare(
        `UPDATE auth_user_identities
         SET email = ?, updated_at = datetime('now')
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind(identityEmail, user.id);
    await db.batch(
      updates.length > 0
        ? [
            db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...params),
            identityUpdate,
          ]
        : [identityUpdate]
    );

    return existing.user_id;
  }

  await db
    .prepare(
      `INSERT INTO users (id, email, name, email_verified, status)
       VALUES (?, ?, ?, 1, 'active')
       ON CONFLICT (email) DO NOTHING`
    )
    .bind(`usr_${crypto.randomUUID()}`, email, user.name)
    .run();
  const localUser = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!localUser) {
    throw new AppError("INTERNAL_ERROR", "Unable to resolve Clerk user");
  }
  const userId = localUser.id;

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
  const userId = await ensureUserMapping(c, {
    id: data.id,
    email,
    name: fullName || data.username,
  });
  const memberships = await new ClerkUsersService(c.env).getOrganizationMemberships(data.id);
  await Promise.all(
    memberships.map((membership) =>
      upsertVerifiedMembership(c, {
        organization: membership.organization,
        userId,
        role: membership.role,
      })
    )
  );
}

async function deleteUser(c: AppContext, data: UserDeletedJSON) {
  if (!data.id) {
    return;
  }

  const identity = await getDb(c.env)
    .prepare(
      `SELECT user_id
       FROM auth_user_identities
       WHERE provider = 'clerk' AND provider_user_id = ?`
    )
    .bind(data.id)
    .first<{ user_id: string }>();

  if (!identity) {
    return;
  }

  await getDb(c.env).transaction(async (tx) => {
    await tx
      .prepare("UPDATE users SET status = 'deleted' WHERE id = ?")
      .bind(identity.user_id)
      .run();
    await revokePendingInvitationsForDeletedUser(tx, identity.user_id);
    await tx
      .prepare("UPDATE organization_members SET status = 'removed' WHERE user_id = ?")
      .bind(identity.user_id)
      .run();
  });
}

/** The address invitations are keyed on. */
async function resolveMemberEmail(c: AppContext, userId: string): Promise<string | null> {
  const user = await getDb(c.env)
    .prepare("SELECT email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();

  return user?.email ?? null;
}

/**
 * Applies a Clerk membership to SDP through the shared admission rules, then
 * mirrors the Clerk role onto a member who was already active (the Clerk
 * organization profile is still where roles change) and provisions the
 * default projects for an admitted member.
 *
 * @param c - Webhook request context
 * @param data - The Clerk membership being applied
 * @param data.organization - Clerk organization the membership belongs to
 * @param data.userId - SDP user id of the member
 * @param data.role - Clerk organization role
 * @returns Resolves once the membership is applied or declined
 */
async function upsertVerifiedMembership(
  c: AppContext,
  data: {
    organization: OrganizationJSON;
    userId: string;
    role: string;
  }
) {
  const organizationId = await ensureOrganizationMapping(c, data.organization);
  const email = await resolveMemberEmail(c, data.userId);
  if (!email) {
    throw new AppError("INTERNAL_ERROR", "Clerk member has no stored email");
  }
  const clerkRole = mapClerkRoleToOrgRole(data.role);

  const admission = await admitOrganizationMember(getDb(c.env), {
    organizationId,
    userId: data.userId,
    email,
    clerkRole,
  });

  if (!admission.admitted) {
    getLogger().warn(
      {
        requestId: c.get("requestId"),
        organizationId,
        userId: data.userId,
        reason: admission.reason,
      },
      "webhooks: declined Clerk membership"
    );
    return;
  }

  if (!admission.joined && admission.role !== clerkRole) {
    await getDb(c.env)
      .prepare(
        `UPDATE organization_members
            SET role = ?
          WHERE organization_id = ? AND user_id = ? AND status = 'active'`
      )
      .bind(clerkRole, organizationId, data.userId)
      .run();
  }

  const projectService = new ProjectService(getDb(c.env));
  await Promise.all([
    projectService.findOrCreateDefault(organizationId, "sandbox", data.userId),
    projectService.findOrCreateDefault(organizationId, "production", data.userId),
  ]);
}

async function upsertMembership(c: AppContext, data: OrganizationMembershipJSON) {
  const email = await resolveVerifiedUserEmail(c.env, data.public_user_data.user_id);
  if (!email) {
    return;
  }
  const userId = await ensureUserMapping(c, {
    id: data.public_user_data.user_id,
    email,
  });
  await upsertVerifiedMembership(c, {
    organization: data.organization,
    userId,
    role: data.role,
  });
}

async function deleteMembership(c: AppContext, data: OrganizationMembershipJSON) {
  const mapping = await findOrganizationMapping(c, data.organization.id);
  if (!mapping) {
    return;
  }

  const identity = await getDb(c.env)
    .prepare(
      `SELECT user_id
       FROM auth_user_identities
       WHERE provider = 'clerk' AND provider_user_id = ?`
    )
    .bind(data.public_user_data.user_id)
    .first<{ user_id: string }>();

  if (!identity) {
    return;
  }

  await getDb(c.env).transaction(async (tx) => {
    await revokePendingInvitationsForUser(tx, mapping.organization_id, identity.user_id);
    await tx
      .prepare(
        `UPDATE organization_members
         SET status = 'removed'
         WHERE organization_id = ? AND user_id = ?`
      )
      .bind(mapping.organization_id, identity.user_id)
      .run();
  });
}

export const handleRampProviderWebhook = async (c: AppContext, environment: SdpEnvironment) => {
  const provider = parseRampWebhookProvider(c.req.param("provider"));
  const rawBody = await c.req.raw.text();
  const processor: WebhookProcessor<unknown, unknown> = RAMP_PROVIDER_WEBHOOK_PROCESSOR[provider];

  const payload = await processor.verify({
    env: c.env as unknown as Record<string, string | undefined>,
    environment,
    headers: c.req.raw.headers,
    rawBody,
    requestUrl: c.req.url,
  });
  processor.parse(payload);

  // Signature and shape are verified, so the event is durable before the 200
  // the provider expects: a crash or DB blip in the background apply can no
  // longer lose the only settlement signal the provider will send — the
  // replay job picks the row back up.
  const stored = await createPostgresRampWebhookEventsRepository(getDb(c.env)).insertEvent({
    provider: processor.provider,
    environment,
    payload,
  });

  // Ack immediately and apply in the background: a slow settlement write must
  // not delay the 2xx. The apply discharges the stored row on success and
  // records the failure on it otherwise, leaving replay to retry.
  // The apply records its own failures on the row; this catch is only for the
  // recording itself failing (the DB going away mid-pass). The row is still
  // pending then, so the replay job picks it up — log and move on.
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
      await deleteUser(c, event.data);
      break;
    case "organizationMembership.created":
    case "organizationMembership.updated":
      await upsertMembership(c, event.data);
      break;
    case "organizationMembership.deleted":
      await deleteMembership(c, event.data);
      break;
    default:
      break;
  }

  return success(c, { received: true });
};
