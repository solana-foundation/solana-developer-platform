import type {
  DeletedObjectJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserDeletedJSON,
  UserJSON,
} from "@clerk/backend";
import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks";
import type { SdpEnvironment } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import { getDb } from "@/db";
import { mapClerkRoleToOrgRole } from "@/lib/clerk-role";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import {
  ensureClerkOrganizationMapping,
  findClerkOrganizationMapping,
  syncClerkOrganization,
} from "@/services/clerk-organization-provisioning.service";
import { type ClerkUser, ClerkUsersService } from "@/services/clerk-users.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";
import { BvnkWebhookProcessor } from "./ramps/bvnk";
import { CoinbaseWebhookProcessor } from "./ramps/coinbase";
import { LightsparkWebhookProcessor } from "./ramps/lightspark";
import { MoonpayWebhookProcessor } from "./ramps/moonpay";
import { MuralWebhookProcessor } from "./ramps/mural";
import type { WebhookProcessor } from "./ramps/processor";
import { StripeWebhookProcessor } from "./ramps/stripe";

type AppContext = Context<{ Bindings: Env }>;

const RAMP_PROVIDER_WEBHOOK_PROCESSOR = {
  moonpay: new MoonpayWebhookProcessor(),
  lightspark: new LightsparkWebhookProcessor(),
  bvnk: new BvnkWebhookProcessor(),
  coinbase: new CoinbaseWebhookProcessor(),
  mural: new MuralWebhookProcessor(),
  stripe: new StripeWebhookProcessor(),
} as const satisfies Record<
  Exclude<RampProviderId, "moneygram">,
  WebhookProcessor<unknown, unknown>
>;

type WebhookRampProvider = keyof typeof RAMP_PROVIDER_WEBHOOK_PROCESSOR;

function parseRampWebhookProvider(value: string | undefined): WebhookRampProvider {
  if (value !== undefined && Object.hasOwn(RAMP_PROVIDER_WEBHOOK_PROCESSOR, value)) {
    return value as WebhookRampProvider;
  }

  throw badRequest("Unsupported ramp webhook provider");
}

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

  await getDb(c.env).batch([
    getDb(c.env)
      .prepare(
        `UPDATE organizations
         SET status = 'deleted', updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(mapping.organization_id),
    getDb(c.env)
      .prepare("UPDATE organization_members SET status = 'removed' WHERE organization_id = ?")
      .bind(mapping.organization_id),
    getDb(c.env)
      .prepare(
        `UPDATE api_keys
         SET status = 'revoked', revoked_at = datetime('now')
         WHERE organization_id = ? AND status = 'active'`
      )
      .bind(mapping.organization_id),
  ]);
}

function primaryEmailFromClerkUser(user: ClerkUser): string | null {
  const emails = user.email_addresses || [];
  const primary = emails.find((item) => item.id === user.primary_email_address_id) || emails[0];
  return primary?.email_address?.toLowerCase() ?? null;
}

async function resolveUserEmail(env: Env, userId: string, fallbackEmail?: string | null) {
  if (fallbackEmail?.includes("@")) {
    return fallbackEmail.toLowerCase();
  }

  const user = await new ClerkUsersService(env).getUser(userId);
  const email = primaryEmailFromClerkUser(user);

  if (!email) {
    throw badRequest("Clerk user missing email");
  }

  return email;
}

async function ensureUserMapping(
  c: AppContext,
  user: { id: string; email?: string | null; name?: string | null }
): Promise<string> {
  const db = getDb(c.env);
  const email = await resolveUserEmail(c.env, user.id, user.email);
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
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
  await ensureUserMapping(c, {
    id: data.id,
    email: primaryEmailFromClerkUser(data),
    name: fullName || data.username,
  });
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

  await getDb(c.env).batch([
    getDb(c.env).prepare("UPDATE users SET status = 'deleted' WHERE id = ?").bind(identity.user_id),
    getDb(c.env)
      .prepare("UPDATE organization_members SET status = 'removed' WHERE user_id = ?")
      .bind(identity.user_id),
  ]);
}

async function upsertMembership(c: AppContext, data: OrganizationMembershipJSON) {
  const organizationId = await ensureOrganizationMapping(c, data.organization);
  const userId = await ensureUserMapping(c, {
    id: data.public_user_data.user_id,
    email: data.public_user_data.identifier,
  });
  const role = mapClerkRoleToOrgRole(data.role);
  const memberId = `mem_${crypto.randomUUID()}`;

  await getDb(c.env)
    .prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, ?, 'active')
       ON CONFLICT(organization_id, user_id)
       DO UPDATE SET
         role = excluded.role,
         status = 'active'`
    )
    .bind(memberId, organizationId, userId, role)
    .run();

  const projectService = new ProjectService(getDb(c.env));
  await Promise.all([
    projectService.findOrCreateDefault(organizationId, "sandbox", userId),
    projectService.findOrCreateDefault(organizationId, "production", userId),
  ]);
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

  await getDb(c.env)
    .prepare(
      `UPDATE organization_members
       SET status = 'removed'
       WHERE organization_id = ? AND user_id = ?`
    )
    .bind(mapping.organization_id, identity.user_id)
    .run();
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
  const event = processor.parse(payload);

  // Signature is verified, so ack with 200 immediately and settle in the background: a
  // slow DB write must not delay the 2xx the provider expects.
  // TODO(ramps): until the reconciliation cron lands, this background pass is the only
  // path that settles a transfer. The cron will reconcile any transaction left in a
  // non-terminal state here (e.g. background processing that failed).
  c.executionCtx.waitUntil(
    processor
      .process(c, environment, event)
      .catch((error) =>
        console.error(
          `[ramp webhook] background processing failed (${processor.provider}): ${error instanceof Error ? error.message : String(error)}`
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
