import { mapClerkRoleToOrgRole } from "@/lib/clerk-role";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import { ClerkUsersService } from "@/services/clerk-users.service";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import { Webhook } from "svix";

type AppContext = Context<{ Bindings: Env }>;

type ClerkWebhookEvent = {
  type: string;
  data: Record<string, unknown>;
};

type ClerkOrgData = {
  id: string | null;
  name: string | null;
  slug: string | null;
};

type ClerkMemberData = {
  userId: string | null;
  role: string | null;
  email: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureUniqueSlug(db: D1Database, base: string): Promise<string> {
  const normalized = slugify(base) || `org-${crypto.randomUUID().slice(0, 8)}`;
  const existing = await db
    .prepare("SELECT id FROM organizations WHERE slug = ?")
    .bind(normalized)
    .first();

  if (!existing) {
    return normalized;
  }

  let suffix = crypto.randomUUID().slice(0, 6);
  let candidate = `${normalized}-${suffix}`;

  for (let i = 0; i < 3; i += 1) {
    const taken = await db
      .prepare("SELECT id FROM organizations WHERE slug = ?")
      .bind(candidate)
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

async function resolveUserEmail(env: Env, member: ClerkMemberData): Promise<string> {
  const email = member.email;
  if (email?.includes("@")) return email.toLowerCase();

  if (!member.userId) {
    throw badRequest("Clerk member missing user id");
  }

  const clerkUsers = new ClerkUsersService(env);
  const user = await clerkUsers.getUser(member.userId);

  const emails = user.email_addresses || [];
  const primary = emails.find((item) => item.id === user.primary_email_address_id) || emails[0];

  if (!primary?.email_address) {
    throw new AppError("BAD_REQUEST", "Clerk user missing email");
  }

  return primary.email_address.toLowerCase();
}

async function ensureOrganizationMapping(c: AppContext, org: ClerkOrgData): Promise<string> {
  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }

  const existing = await c.env.DB.prepare(
    `SELECT organization_id
     FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = ?`
  )
    .bind(org.id)
    .first<{ organization_id: string }>();

  if (existing) {
    return existing.organization_id;
  }

  let orgName = org.name?.trim();
  let orgSlug = org.slug?.trim();

  if (!orgName || !orgSlug) {
    const clerkService = new ClerkOrganizationsService(c.env);
    const clerkOrg = await clerkService.getOrganization(org.id);
    orgName = orgName || clerkOrg.name?.trim() || "New Organization";
    orgSlug = orgSlug || clerkOrg.slug?.trim() || undefined;
  }

  orgName = orgName || "New Organization";
  const slugBase = orgSlug || orgName || org.id;
  const slug = await ensureUniqueSlug(c.env.DB, slugBase);

  const orgId = `org_${crypto.randomUUID()}`;
  const authOrgId = `aoi_${crypto.randomUUID()}`;

  const batch = [
    c.env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, 'free', 'active')`
    ).bind(orgId, orgName, slug),
    c.env.DB.prepare(
      `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
       VALUES (?, 'clerk', ?, ?, ?)`
    ).bind(authOrgId, org.id, orgId, slug),
  ];

  try {
    await c.env.DB.batch(batch);
  } catch (err) {
    if (err instanceof Error && err.message?.includes("UNIQUE constraint")) {
      const retry = await c.env.DB.prepare(
        `SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
        .bind(org.id)
        .first<{ organization_id: string }>();
      if (retry) {
        return retry.organization_id;
      }
    }
    throw err;
  }

  return orgId;
}

async function ensureUserMapping(
  c: AppContext,
  params: { clerkUserId: string; email: string }
): Promise<string> {
  const existing = await c.env.DB.prepare(
    `SELECT user_id
     FROM auth_user_identities
     WHERE provider = 'clerk' AND provider_user_id = ?`
  )
    .bind(params.clerkUserId)
    .first<{ user_id: string }>();

  if (existing?.user_id) {
    return existing.user_id;
  }

  const normalizedEmail = params.email.toLowerCase();
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string }>();

  const userId = user?.id ?? `usr_${crypto.randomUUID()}`;

  if (!user) {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, ?, 1, 'active')`
    )
      .bind(userId, normalizedEmail)
      .run();
  }

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
     VALUES (?, 'clerk', ?, ?, ?)`
  )
    .bind(`aui_${crypto.randomUUID()}`, params.clerkUserId, userId, normalizedEmail)
    .run();

  return userId;
}

async function ensureMembership(
  c: AppContext,
  params: { organizationId: string; userId: string; role: string | null }
) {
  const role = mapClerkRoleToOrgRole(params.role);

  const memberId = `mem_${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES (?, ?, ?, ?, 'active')
     ON CONFLICT(organization_id, user_id)
     DO UPDATE SET
       role = excluded.role,
       status = 'active'`
  )
    .bind(memberId, params.organizationId, params.userId, role)
    .run();
}

async function deactivateMembership(
  c: AppContext,
  params: { organizationId: string; userId: string }
) {
  await c.env.DB.prepare(
    `UPDATE organization_members
     SET status = 'inactive'
     WHERE organization_id = ? AND user_id = ?`
  )
    .bind(params.organizationId, params.userId)
    .run();
}

async function handleOrganizationCreated(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  await ensureOrganizationMapping(c, org);
}

async function handleOrganizationMembershipCreated(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  const member = extractMember(data);

  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }
  if (!member.userId) {
    throw badRequest("Clerk member user id missing");
  }

  const organizationId = await ensureOrganizationMapping(c, org);
  const email = await resolveUserEmail(c.env, member);
  const userId = await ensureUserMapping(c, {
    clerkUserId: member.userId,
    email,
  });

  await ensureMembership(c, { organizationId, userId, role: member.role });
}

async function handleOrganizationMembershipUpdated(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  const member = extractMember(data);

  if (!org.id) {
    throw badRequest("Clerk organization id missing");
  }
  if (!member.userId) {
    throw badRequest("Clerk member user id missing");
  }

  const organizationId = await ensureOrganizationMapping(c, org);
  const email = await resolveUserEmail(c.env, member);
  const userId = await ensureUserMapping(c, {
    clerkUserId: member.userId,
    email,
  });

  await ensureMembership(c, { organizationId, userId, role: member.role });
}

async function handleOrganizationMembershipDeleted(c: AppContext, data: Record<string, unknown>) {
  const org = extractOrganization(data);
  const member = extractMember(data);

  if (!org.id) {
    return;
  }

  if (!member.userId) {
    return;
  }

  const organizationId = await ensureOrganizationMapping(c, org);
  const identity = await c.env.DB.prepare(
    `SELECT user_id
     FROM auth_user_identities
     WHERE provider = 'clerk' AND provider_user_id = ?`
  )
    .bind(member.userId)
    .first<{ user_id: string }>();

  if (!identity?.user_id) {
    return;
  }

  await deactivateMembership(c, { organizationId, userId: identity.user_id });
}

function requiredHeader(c: AppContext, name: string) {
  const value = c.req.header(name);
  if (!value) {
    throw badRequest(`Missing webhook header: ${name}`);
  }
  return value;
}

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
      await handleOrganizationCreated(c, data);
      break;
    // biome-ignore lint/nursery/noSecrets: Webhook event type literal, not a secret.
    case "organizationMembership.created":
      await handleOrganizationMembershipCreated(c, data);
      break;
    // biome-ignore lint/nursery/noSecrets: Webhook event type literal, not a secret.
    case "organizationMembership.updated":
      await handleOrganizationMembershipUpdated(c, data);
      break;
    // biome-ignore lint/nursery/noSecrets: Webhook event type literal, not a secret.
    case "organizationMembership.deleted":
      await handleOrganizationMembershipDeleted(c, data);
      break;
    default:
      break;
  }

  return success(c, { received: true });
};
