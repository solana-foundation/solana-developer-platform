import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, Permission } from "@sdp/types";
import { getDb } from "@/db/client";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

export interface EarnTestApiKey {
  id: string;
  raw: string;
  prefix: string;
  permissions: Permission[];
}

export interface EarnAuthzTenant {
  org: {
    id: string;
    name: string;
    slug: string;
  };
  user: {
    id: string;
    email: string;
  };
  project: {
    id: string;
    slug: string;
  };
  token: string;
}

export async function seedEarnAuthzTenant(
  env: Env,
  tag: string,
  options: {
    environment: CachedApiKey["environment"];
  }
): Promise<EarnAuthzTenant> {
  const environment = options.environment;
  const tenant = {
    org: { id: `org_test_${tag}`, name: `Earn Authz ${tag}`, slug: `earn-authz-${tag}` },
    user: { id: `usr_test_${tag}`, email: `${tag}@earn-authz.example.com` },
    project: {
      id: `prj_${tag}_pinned`,
      slug: environment === "sandbox" ? "default-sandbox" : "default-production",
    },
  };
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'enterprise', 'active', '{}')"
      )
      .bind(tenant.org.id, tenant.org.name, tenant.org.slug),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(tenant.user.id, tenant.user.email),
  ]);
  await seedDefaultProjects(db, {
    organizationId: tenant.org.id,
    createdBy: tenant.user.id,
    members: [tenant.user.id],
    ids:
      environment === "sandbox"
        ? { sandbox: tenant.project.id, production: `prj_${tag}_production` }
        : { sandbox: `prj_${tag}_sandbox`, production: tenant.project.id },
  });
  const { token } = await authenticateTestClerkUser(env, db, {
    userId: tenant.user.id,
    email: tenant.user.email,
    clerkUserId: `clerk_user_${tag}`,
    organizationId: tenant.org.id,
    clerkOrgId: `clerk_org_${tag}`,
    orgSlug: tenant.org.slug,
    role: "admin",
  });
  return { ...tenant, token };
}

export async function seedEarnApiKey(
  env: Env,
  tenant: EarnAuthzTenant,
  key: {
    id: string;
    permissions: Permission[];
    environment: CachedApiKey["environment"];
  }
): Promise<EarnTestApiKey> {
  const raw = `sk_test_${key.id}`;
  const cached: CachedApiKey = {
    id: key.id,
    organizationId: tenant.org.id,
    projectId: tenant.project.id,
    role: "api_admin",
    permissions: key.permissions,
    environment: key.environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
  await seedCachedApiKey(env, await hashString(raw, env.API_KEY_PEPPER), cached);
  await getDb(env)
    .prepare(`INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', ?, 'active')`)
    .bind(
      key.id,
      tenant.org.id,
      tenant.project.id,
      tenant.user.id,
      `Earn authz ${key.id}`,
      raw.slice(0, 11),
      await hashString(raw, env.API_KEY_PEPPER),
      JSON.stringify(key.permissions)
    )
    .run();
  return { id: key.id, raw, prefix: raw.slice(0, 11), permissions: key.permissions };
}
