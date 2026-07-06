import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { Webhook } from "svix";
import { getDb } from "@/db";
import { mapClerkRoleToOrgRole } from "@/lib/clerk-role";
import { AppError, badRequest } from "@/lib/errors";
import { readString } from "@/lib/json";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import { success } from "@/lib/response";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import {
  type ClerkOrganization,
  ClerkOrganizationsService,
} from "@/services/clerk-organizations.service";
import { type ClerkUser, ClerkUsersService } from "@/services/clerk-users.service";
import { ProjectService } from "@/services/project.service";
import { syncProviderAccessFromClerk } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";
import { handleBvnkRampWebhook } from "./ramps/bvnk";
import { handleCoinbaseRampWebhook } from "./ramps/coinbase";
import { handleLightsparkRampWebhook } from "./ramps/lightspark";
import { handleMoonpayRampWebhook } from "./ramps/moonpay";

type AppContext = Context<{ Bindings: Env }>;

type ClerkWebhookEvent = {
  type: string;
  data: Record<string, unknown>;
};

type WebhookRampProvider = keyof typeof RAMP_PROVIDER_CLIENTS;

type ClerkOrgData = {
  id: string | undefined;
  name: string | undefined;
  slug: string | undefined;
};

type ClerkMemberData = {
  userId: string | undefined;
  role: string | undefined;
  email: string | undefined;
};

type ClerkUserData = {
  id: string | undefined;
  email: string | undefined;
  name: string | undefined;
};

type OrganizationMapping = {
  organizationId: string;
  clerkOrganization: ClerkOrganization | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseRampWebhookProvider(value: string | undefined): WebhookRampProvider {
  if (value !== undefined && Object.hasOwn(RAMP_PROVIDER_CLIENTS, value)) {
    return value as WebhookRampProvider;
  }

  throw badRequest("Unsupported ramp webhook provider");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureUniqueSlug(
  db: DatabaseClient,
  base: string,
  excludeOrganizationId?: string
): Promise<string> {
  const normalized = slugify(base) || `org-${crypto.randomUUID().slice(0, 8)}`;
  const existing = await db
    .prepare(
      excludeOrganizationId
        ? "SELECT id FROM organizations WHERE slug = ? AND id <> ?"
        : "SELECT id FROM organizations WHERE slug = ?"
    )
    .bind(...(excludeOrganizationId ? [normalized, excludeOrganizationId] : [normalized]))
    .first();

  if (!existing) {
    return normalized;
  }

  let suffix = crypto.randomUUID().slice(0, 6);
  let candidate = `${normalized}-${suffix}`;

  for (let i = 0; i < 3; i += 1) {
    const taken = await db
      .prepare(
        excludeOrganizationId
          ? "SELECT id FROM organizations WHERE slug = ? AND id <> ?"
          : "SELECT id FROM organizations WHERE slug = ?"
      )
      .bind(...(excludeOrganizationId ? [candidate, excludeOrganizationId] : [candidate]))
      .first();
    if (!taken) {
      return candidate;
    }
    suffix = crypto.randomUUID().slice(0, 6);
    candidate = `${normalized}-${suffix}`;
  }

  return candidate;
}

function extractOrganization(data: Record<string, unknown>): ClerkOrgData {
  const organization = asRecord(data.organization) ?? data;
  const id =
    readString(data.organization_id) ||
    readString(data.organizationId) ||
    readString(organization?.id);
  const name = readString(organization?.name) || readString(data.name);
  const slug = readString(organization?.slug) || readString(data.slug);

  return { id, name, slug };
}

function extractMember(data: Record<string, unknown>): ClerkMemberData {
  const publicUser = asRecord(data.public_user_data) ?? asRecord(data.publicUserData);
  const userId =
    readString(data.user_id) ||
    readString(data.userId) ||
    readString(publicUser?.user_id) ||
    readString(publicUser?.userId);
  const role = readString(data.role);
  const email =
    readString(publicUser?.identifier) ||
    readString(publicUser?.email_address) ||
    readString(publicUser?.emailAddress);

  return { userId, role, email };
}

function extractPrimaryEmail(data: Record<string, unknown>): string | undefined {
  const emailAddresses = Array.isArray(data.email_addresses) ? data.email_addresses : [];
  const primaryEmailId = readString(data.primary_email_address_id);

  for (const item of emailAddresses) {
    const emailRecord = asRecord(item);
    if (!emailRecord) {
      continue;
    }

    const email = readString(emailRecord.email_address);
    if (email && readString(emailRecord.id) === primaryEmailId) {
      return email;
    }
  }

  for (const item of emailAddresses) {
    const emailRecord = asRecord(item);
    const email = emailRecord ? readString(emailRecord.email_address) : undefined;
    if (email) {
      return email;
    }
  }

  return readString(data.email_address);
}

function extractUser(data: Record<string, unknown>): ClerkUserData {
  const firstName = readString(data.first_name);
  const lastName = readString(data.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = fullName || readString(data.name) || readString(data.username);

  return {
    id: readString(data.id) || readString(data.user_id) || readString(data.userId),
    email: extractPrimaryEmail(data),
    name,
  };
}

async function findOrganizationMapping(c: AppContext, clerkOrgId: string) {
  return getDb(c.env)
    .prepare(
      `SELECT organization_id, slug
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrgId)
    .first<{ organization_id: string; slug: string | null }>();
}

async function resolveClerkOrganization(
  c: AppContext,
  org: ClerkOrgData,
  privateMetadata?: unknown
): Promise<ClerkOrganization> {
  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }

  if (org.name && org.slug) {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ...(privateMetadata !== undefined ? { private_metadata: asRecord(privateMetadata) } : {}),
    };
  }

  const clerkOrg = await new ClerkOrganizationsService(c.env).getOrganization(org.id);
  return {
    id: org.id,
    name: org.name ?? clerkOrg.name,
    slug: org.slug ?? clerkOrg.slug,
    private_metadata:
      privateMetadata !== undefined ? asRecord(privateMetadata) : clerkOrg.private_metadata,
  };
}

async function ensureOrganizationMapping(
  c: AppContext,
  org: ClerkOrgData,
  privateMetadata?: unknown
): Promise<OrganizationMapping> {
  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }

  const existing = await findOrganizationMapping(c, org.id);
  if (existing) {
    return {
      organizationId: existing.organization_id,
      clerkOrganization: null,
    };
  }

  const clerkOrg = await resolveClerkOrganization(c, org, privateMetadata);
  const orgName = clerkOrg.name?.trim() || "New Organization";
  const slug = await ensureUniqueSlug(getDb(c.env), clerkOrg.slug || orgName || org.id);
  const orgId = `org_${crypto.randomUUID()}`;
  const authOrgId = `aoi_${crypto.randomUUID()}`;

  try {
    await getDb(c.env).batch([
      getDb(c.env)
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, ?, ?, 'enterprise', 'active')`
        )
        .bind(orgId, orgName, slug),
      getDb(c.env)
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind(authOrgId, org.id, orgId, slug),
    ]);

    if (!isSelfHostedDeployment(c.env)) {
      await syncProviderAccessFromClerk(getDb(c.env), {
        organizationId: orgId,
        clerkOrganization: clerkOrg,
      });
    }
  } catch (err) {
    if (err instanceof Error && err.message?.includes("UNIQUE constraint")) {
      const retry = await findOrganizationMapping(c, org.id);
      if (retry) {
        return {
          organizationId: retry.organization_id,
          clerkOrganization: clerkOrg,
        };
      }
    }
    throw err;
  }

  return {
    organizationId: orgId,
    clerkOrganization: clerkOrg,
  };
}

async function syncOrganization(c: AppContext, data: Record<string, unknown>) {
  const db = getDb(c.env);
  const org = extractOrganization(data);
  const mapping = await ensureOrganizationMapping(c, org, data.private_metadata);
  const { organizationId } = mapping;
  const clerkOrg =
    mapping.clerkOrganization ?? (await resolveClerkOrganization(c, org, data.private_metadata));

  const updates: string[] = [];
  const params: string[] = [];
  let nextSlug: string | null = null;

  if (clerkOrg.name?.trim()) {
    updates.push("name = ?");
    params.push(clerkOrg.name.trim());
  }

  if (clerkOrg.slug?.trim()) {
    const slug = await ensureUniqueSlug(db, clerkOrg.slug, organizationId);
    nextSlug = slug;
    updates.push("slug = ?");
    params.push(slug);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(organizationId);

    const organizationUpdate = db
      .prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params);

    if (nextSlug) {
      await db.batch([
        db
          .prepare(
            `UPDATE auth_organization_identities
             SET slug = ?, updated_at = datetime('now')
             WHERE provider = 'clerk' AND provider_org_id = ?`
          )
          .bind(nextSlug, clerkOrg.id),
        organizationUpdate,
      ]);
    } else {
      await organizationUpdate.run();
    }
  }

  if (!isSelfHostedDeployment(c.env)) {
    await syncProviderAccessFromClerk(db, {
      organizationId,
      clerkOrganization: clerkOrg,
    });
  }
}

async function deleteOrganization(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  if (!org.id) {
    return;
  }

  const mapping = await findOrganizationMapping(c, org.id);
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

async function ensureUserMapping(c: AppContext, user: ClerkUserData): Promise<string> {
  if (!user.id) {
    throw badRequest("Clerk user id missing");
  }

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

async function syncUser(c: AppContext, data: Record<string, unknown>) {
  await ensureUserMapping(c, extractUser(data));
}

async function deleteUser(c: AppContext, data: Record<string, unknown>) {
  const user = extractUser(data);
  if (!user.id) {
    return;
  }

  const identity = await getDb(c.env)
    .prepare(
      `SELECT user_id
       FROM auth_user_identities
       WHERE provider = 'clerk' AND provider_user_id = ?`
    )
    .bind(user.id)
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

async function upsertMembership(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  const member = extractMember(data);

  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }
  if (!member.userId) {
    throw badRequest("Clerk member user id missing");
  }

  const { organizationId } = await ensureOrganizationMapping(c, org);
  const userId = await ensureUserMapping(c, {
    id: member.userId,
    email: member.email,
    name: undefined,
  });
  const role = mapClerkRoleToOrgRole(member.role);
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

async function deleteMembership(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  const member = extractMember(data);

  if (!org.id || !member.userId) {
    return;
  }

  const mapping = await findOrganizationMapping(c, org.id);
  if (!mapping) {
    return;
  }

  const identity = await getDb(c.env)
    .prepare(
      `SELECT user_id
       FROM auth_user_identities
       WHERE provider = 'clerk' AND provider_user_id = ?`
    )
    .bind(member.userId)
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

function requiredHeader(c: AppContext, name: string) {
  const value = c.req.header(name);
  if (!value) {
    throw badRequest(`Missing webhook header: ${name}`);
  }
  return value;
}

export const handleRampProviderWebhook = async (c: AppContext, environment: SdpEnvironment) => {
  const provider = parseRampWebhookProvider(c.req.param("provider"));
  const rawBody = await c.req.raw.text();

  const result = await RAMP_PROVIDER_CLIENTS[provider].validateWebhook({
    env: c.env as unknown as Record<string, string | undefined>,
    environment,
    headers: c.req.raw.headers,
    rawBody,
    requestUrl: c.req.url,
  });

  const dispatch = async () => {
    switch (result.provider) {
      case "bvnk":
        await handleBvnkRampWebhook(c, environment, result.payload);
        break;
      case "lightspark":
        await handleLightsparkRampWebhook(c, result.payload);
        break;
      case "moonpay":
        await handleMoonpayRampWebhook(c, result.payload);
        break;
      case "moneygram":
        throw badRequest("MoneyGram does not deliver webhooks.");
      case "coinbase":
        await handleCoinbaseRampWebhook(c, result.payload);
        break;
      default:
        throw badRequest(`Unsupported ramp webhook provider: ${result.provider satisfies never}`);
    }
  };

  // Signature is verified, so ack with 200 immediately and settle in the background: a
  // slow DB write must not delay the 2xx the provider expects.
  // TODO(ramps): until the reconciliation cron lands, this background pass is the only
  // path that settles a transfer. The cron will reconcile any transaction left in a
  // non-terminal state here (e.g. background processing that failed).
  c.executionCtx.waitUntil(
    dispatch().catch((error) =>
      console.error(
        `[ramp webhook] background processing failed (${result.provider}): ${error instanceof Error ? error.message : String(error)}`
      )
    )
  );

  return success(c, {
    received: true,
    provider: result.provider,
    environment,
  });
};

export const handleClerkWebhook = async (c: AppContext) => {
  const secret = c.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError("INTERNAL_ERROR", "CLERK_WEBHOOK_SECRET is required");
  }

  const payload = await c.req.raw.text();
  const headers = {
    "svix-id": requiredHeader(c, "svix-id"),
    "svix-timestamp": requiredHeader(c, "svix-timestamp"),
    "svix-signature": requiredHeader(c, "svix-signature"),
  };

  let event: ClerkWebhookEvent;
  try {
    event = new Webhook(secret).verify(payload, headers) as ClerkWebhookEvent;
  } catch (err) {
    throw new AppError("UNAUTHORIZED", "Invalid webhook signature", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!event?.type) {
    throw badRequest("Webhook event type missing");
  }

  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "organization.created":
    case "organization.updated":
      await syncOrganization(c, data);
      break;
    case "organization.deleted":
      await deleteOrganization(c, data);
      break;
    case "user.created":
    case "user.updated":
      await syncUser(c, data);
      break;
    case "user.deleted":
      await deleteUser(c, data);
      break;
    case "organizationMembership.created":
    case "organizationMembership.updated":
      await upsertMembership(c, data);
      break;
    case "organizationMembership.deleted":
      await deleteMembership(c, data);
      break;
    default:
      break;
  }

  return success(c, { received: true });
};
