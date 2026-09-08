/**
 * Earn authz/tenancy test fixture (PRO-1860).
 *
 * The earn route suites each hand-roll their own seeds; the authz matrix and
 * the cross-tenant cells need the same shapes with the sharp edges handled
 * once:
 *
 * - **API keys must be double-written** — the KV cache (what auth resolves,
 *   including `walletScope`/bindings) AND an `api_keys` row (the DB resolution
 *   path, FKs, RLS) — or a test proves nothing (see
 *   `earn.movements.test.ts`'s header comment).
 * - **Sessions are three rows and a cookie**: `organization_members`,
 *   `project_members`, `sessions`, then `Cookie: sdp_session=<id>` plus the
 *   `x-project-id` header (dashboard callers select their project per
 *   request).
 *
 * Deliberately NOT here: strategy/position/movement seeds. Those stay next to
 * the suites that own their semantics; this helper owns identity and scoping
 * only.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, Permission } from "@sdp/types";
import { getDb } from "@/db/client";
import { seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

export interface EarnTestApiKey {
  id: string;
  raw: string;
  prefix: string;
  permissions: Permission[];
}

export interface EarnAuthzTenant {
  org: { id: string; name: string; slug: string };
  user: { id: string; email: string };
  /** The key's pinned project (sandbox). */
  project: { id: string; slug: string };
  /** A sibling sandbox project in the same org, no key pinned to it. */
  siblingProject: { id: string; slug: string };
  /** A same-org project the session user is NOT a member of. */
  nonMemberProject: { id: string; slug: string };
  /** Session for `user`: org member, project-member of `project` only. */
  sessionId: string;
}

/**
 * Seed one org with the three projects and the session the authz matrix
 * exercises. Call after `seedTestDatabase(env)`.
 */
export async function seedEarnAuthzTenant(
  env: Env,
  tag: string,
  options: { environment?: string } = {}
): Promise<EarnAuthzTenant> {
  const environment = options.environment ?? "sandbox";
  const tenant: EarnAuthzTenant = {
    org: { id: `org_${tag}`, name: `Earn Authz ${tag}`, slug: `earn-authz-${tag}` },
    user: { id: `usr_${tag}`, email: `${tag}@earn-authz.example.com` },
    project: { id: `prj_${tag}_pinned`, slug: `earn-authz-${tag}-pinned` },
    siblingProject: { id: `prj_${tag}_sibling`, slug: `earn-authz-${tag}-sibling` },
    nonMemberProject: { id: `prj_${tag}_nonmember`, slug: `earn-authz-${tag}-nonmember` },
    sessionId: `sess_${tag}`,
  };

  const db = getDb(env);
  const projectInsert = `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'enterprise', 'active', '{}')"
      )
      .bind(tenant.org.id, tenant.org.name, tenant.org.slug),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(tenant.user.id, tenant.user.email),
    db
      .prepare(projectInsert)
      .bind(
        tenant.project.id,
        tenant.org.id,
        "Pinned",
        tenant.project.slug,
        environment,
        tenant.user.id
      ),
    db
      .prepare(projectInsert)
      .bind(
        tenant.siblingProject.id,
        tenant.org.id,
        "Sibling",
        tenant.siblingProject.slug,
        environment,
        tenant.user.id
      ),
    db
      .prepare(projectInsert)
      .bind(
        tenant.nonMemberProject.id,
        tenant.org.id,
        "NonMember",
        tenant.nonMemberProject.slug,
        environment,
        tenant.user.id
      ),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind(`om_${tag}`, tenant.org.id, tenant.user.id),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
      )
      .bind(`pm_${tag}_pinned`, tenant.project.id, tenant.user.id),
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', '2099-01-01T00:00:00.000Z')`
      )
      .bind(tenant.sessionId, tenant.user.id, tenant.org.id),
  ]);

  return tenant;
}

/**
 * Seed one API key (KV cache + `api_keys` row) pinned to `tenant.project`,
 * carrying exactly `permissions`. Returns the raw bearer value.
 */
export async function seedEarnApiKey(
  env: Env,
  tenant: EarnAuthzTenant,
  key: { id: string; permissions: Permission[]; environment?: string }
): Promise<EarnTestApiKey> {
  const raw = `sk_test_${key.id}`;
  const cached: CachedApiKey = {
    id: key.id,
    organizationId: tenant.org.id,
    projectId: tenant.project.id,
    role: "api_admin",
    permissions: key.permissions,
    environment: (key.environment ?? "sandbox") as CachedApiKey["environment"],
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
  await seedCachedApiKey(env, await hashString(raw, env.API_KEY_PEPPER), cached);
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', ?, 'active')`
    )
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
