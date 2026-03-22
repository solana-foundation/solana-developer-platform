import { AppError, conflict, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import type { Env } from "@/types/env";
import type { Context } from "hono";

type AppContext = Context<{ Bindings: Env }>;

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

  // Try a couple of times if needed
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

async function fetchOrganization(db: D1Database, orgId: string) {
  const org = await db
    .prepare(
      `SELECT id, name, slug, tier, status, settings, created_at, updated_at
       FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<{
      id: string;
      name: string;
      slug: string;
      tier: string;
      status: string;
      settings: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!org) {
    throw notFound("Organization");
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    tier: org.tier as "free" | "pro" | "enterprise",
    status: org.status as "active" | "suspended" | "deleted",
    settings: org.settings ? JSON.parse(org.settings) : null,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
  };
}

export const getOnboardingStatus = async (c: AppContext) => {
  const clerk = c.get("clerkOnboarding");
  if (!clerk) {
    throw new AppError("UNAUTHORIZED", "Clerk session required");
  }

  const mapping = await c.env.DB.prepare(
    `SELECT organization_id
     FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = ?`
  )
    .bind(clerk.clerkOrgId)
    .first<{ organization_id: string }>();

  if (!mapping) {
    return success(c, { linked: false, organization: null });
  }

  const organization = await fetchOrganization(c.env.DB, mapping.organization_id);
  return success(c, { linked: true, organization });
};

export const linkOrganization = async (c: AppContext) => {
  const clerk = c.get("clerkOnboarding");
  if (!clerk) {
    throw new AppError("UNAUTHORIZED", "Clerk session required");
  }

  const existingMapping = await c.env.DB.prepare(
    `SELECT organization_id
     FROM auth_organization_identities
     WHERE provider = 'clerk' AND provider_org_id = ?`
  )
    .bind(clerk.clerkOrgId)
    .first<{ organization_id: string }>();

  if (existingMapping) {
    const organization = await fetchOrganization(c.env.DB, existingMapping.organization_id);
    return success(c, { linked: true, organization, apiKey: null });
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
  };

  const clerkService = new ClerkOrganizationsService(c.env);
  const clerkOrg = await clerkService.getOrganization(clerk.clerkOrgId);

  const orgName = body.name?.trim() || clerkOrg.name?.trim() || "New Organization";
  const tier = "free";
  const slugBase = body.slug?.trim() || clerkOrg.slug?.trim() || clerk.orgSlug || slugify(orgName);
  const slug = await ensureUniqueSlug(c.env.DB, slugBase);

  const normalizedEmail = clerk.email.toLowerCase();

  const existingIdentity = await c.env.DB.prepare(
    `SELECT user_id, email
     FROM auth_user_identities
     WHERE provider = 'clerk' AND provider_user_id = ?`
  )
    .bind(clerk.clerkUserId)
    .first<{ user_id: string; email: string | null }>();

  let userId = existingIdentity?.user_id;
  let user =
    userId &&
    (await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(userId)
      .first<{ id: string }>());

  if (!user) {
    user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(normalizedEmail)
      .first<{ id: string }>();
    userId = user?.id;
  }

  const orgId = `org_${crypto.randomUUID()}`;
  userId = userId || `usr_${crypto.randomUUID()}`;
  const memberId = `mem_${crypto.randomUUID()}`;
  const authOrgId = `aoi_${crypto.randomUUID()}`;
  const authUserId = `aui_${crypto.randomUUID()}`;

  const batch: D1PreparedStatement[] = [];

  if (!user) {
    batch.push(
      c.env.DB.prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      ).bind(userId, normalizedEmail)
    );
  }

  batch.push(
    c.env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, ?, 'active')`
    ).bind(orgId, orgName, slug, tier),
    c.env.DB.prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, 'admin', 'active')`
    ).bind(memberId, orgId, userId),
    c.env.DB.prepare(
      `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
       VALUES (?, 'clerk', ?, ?, ?)`
    ).bind(authOrgId, clerk.clerkOrgId, orgId, slug),
    ...(existingIdentity
      ? []
      : [
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
             VALUES (?, 'clerk', ?, ?, ?)`
          ).bind(authUserId, clerk.clerkUserId, userId, normalizedEmail),
        ])
  );

  try {
    await c.env.DB.batch(batch);
  } catch (err) {
    if (err instanceof Error && err.message?.includes("UNIQUE constraint")) {
      throw conflict("Organization already linked");
    }
    throw err;
  }

  const organization = await fetchOrganization(c.env.DB, orgId);

  return created(c, {
    linked: true,
    organization,
    apiKey: null,
  });
};
