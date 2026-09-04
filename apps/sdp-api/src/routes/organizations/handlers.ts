import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TIERS,
  type Organization,
  type OrganizationSettings,
  type OrganizationStatus,
  type OrganizationTier,
} from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { refreshApiKeyCache } from "@/lib/api-key-cache";
import { getAuth } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import {
  assertProviderAvailable,
  getProviderAvailability,
} from "@/services/provider-availability.service";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import type { updateOrgSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  settings: string | null;
  created_at: string;
  updated_at: string;
};

function parseOrganizationSettings(raw: string | null): OrganizationSettings | null {
  if (!raw) {
    return null;
  }

  try {
    return parsePostgresJson<OrganizationSettings>(raw);
  } catch {
    return null;
  }
}

function parseOrganizationTier(value: string): OrganizationTier {
  if (ORGANIZATION_TIERS.includes(value as OrganizationTier)) {
    return value as OrganizationTier;
  }
  if (value === "standard" || value === "starter") {
    return "individual";
  }
  if (value === "pro" || value === "growth") {
    return "enterprise";
  }
  throw new AppError("INTERNAL_ERROR", `Organization tier '${value}' is invalid`);
}

function parseOrganizationStatus(value: string): OrganizationStatus {
  if (ORGANIZATION_STATUSES.includes(value as OrganizationStatus)) {
    return value as OrganizationStatus;
  }
  throw new AppError("INTERNAL_ERROR", `Organization status '${value}' is invalid`);
}

function toOrganizationResponse(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tier: parseOrganizationTier(row.tier),
    status: parseOrganizationStatus(row.status),
    settings: parseOrganizationSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const getOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  // Verify access to this organization
  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const org = await getDb(c.env)
    .prepare(
      `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<OrganizationRow>();

  if (!org) {
    throw notFound("Organization");
  }

  const response = toOrganizationResponse(org);

  return success(c, response);
};

/**
 * Refuses an allowlist that would shut out the request installing it. The
 * restriction covers this endpoint and the dashboard, so such a list is
 * unrecoverable through the API — only database access could undo it. A
 * missing client IP is refused too: enforcement fails closed without one.
 */
function assertAllowlistAdmitsCaller(c: AppContext, allowedIps: string[] | undefined): void {
  if (allowedIps === undefined || allowedIps.length === 0) {
    return;
  }

  const clientIp = getClientIp(c);

  if (!isClientIpAllowed(clientIp, allowedIps)) {
    throw badRequest(
      clientIp
        ? `The allowed IP list must include the address this request came from (${clientIp}), or it would lock the organization out.`
        : "No client IP could be determined for this request, so an allowed IP list cannot be verified. It would lock the organization out."
    );
  }
}

export const updateOrganization = async (c: ValidatedBodyContext<typeof updateOrgSchema>) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const body = c.req.valid("json");

  const settingsPatch = body.settings;

  if (body.name === undefined && settingsPatch === undefined) {
    throw badRequest("No valid updates provided");
  }

  assertAllowlistAdmitsCaller(c, settingsPatch?.allowedIpAddresses);

  // Checked outside the transaction so the row is not held while it runs.
  if (settingsPatch?.rpcProvider) {
    await assertProviderAvailable(c.env, getDb(c.env), orgId, "rpc", settingsPatch.rpcProvider);
  }

  // Settings are one JSON column patched by read-merge-write. Unsynchronized,
  // the second commit silently drops the first — an unrelated edit could revert
  // a just-installed allowlist. The row lock makes concurrent merges compose.
  const org = await getDb(c.env).transaction(async (tx) => {
    const existing = await tx
      .prepare(
        `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ? FOR UPDATE`
      )
      .bind(orgId)
      .first<OrganizationRow>();

    if (!existing) {
      throw notFound("Organization");
    }

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (body.name !== undefined) {
      updates.push("name = ?");
      params.push(body.name);
    }

    if (settingsPatch !== undefined) {
      const mergedSettings: OrganizationSettings = {
        ...(parseOrganizationSettings(existing.settings) ?? {}),
        ...settingsPatch,
      };
      updates.push("settings = ?");
      params.push(JSON.stringify(mergedSettings));
    }

    updates.push("updated_at = datetime('now')");
    params.push(orgId);

    await tx
      .prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params)
      .run();

    const updated = await tx
      .prepare(
        `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
      )
      .bind(orgId)
      .first<OrganizationRow>();

    if (!updated) {
      throw notFound("Organization");
    }

    return updated;
  });

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "organization",
    resourceId: orgId,
    // Canonical form, not the submitted spelling: the trail records what was granted.
    metadata: { ...body, ...(settingsPatch ? { settings: settingsPatch } : {}) },
  });

  return success(c, toOrganizationResponse(org));
};

export const getOrganizationProviderAccess = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const response = await getProviderAvailability(c.env, getDb(c.env), orgId);
  return success(c, response);
};

export const deleteOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);
  const db = getDb(c.env);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  await db.batch([
    db
      .prepare(
        `UPDATE organizations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
      )
      .bind(orgId),
    db
      .prepare("UPDATE organization_members SET status = 'removed' WHERE organization_id = ?")
      .bind(orgId),
    db
      .prepare(
        `UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE organization_id = ?`
      )
      .bind(orgId),
  ]);

  // Everything below is post-commit: the organization is deleted, its
  // memberships are removed and its keys are revoked in Postgres. Each
  // remaining effect is therefore isolated — one of them throwing must never
  // skip the others, because every one of them is what actually stops a live
  // credential. Failures are collected and reported once at the end.
  const failures: unknown[] = [];

  // Cached entries keep authenticating for the remainder of the cache TTL
  // until the revoked state is pushed into them. The hashes are queried
  // AFTER the batch commits: a key created concurrently with this request
  // still gets revoked by it, and a pre-batch snapshot would miss that key.
  // Transient cache errors are retried with backoff here rather than
  // aborting, so the caller is not left with a committed deletion it cannot
  // retry; keys that never succeed become the 500 below, which the
  // per-minute reconciliation sweep then repairs from the revoked rows.
  try {
    const orgKeyHashes = await db
      .prepare("SELECT key_hash FROM api_keys WHERE organization_id = ?")
      .bind(orgId)
      .all<{ key_hash: string }>();

    let pendingHashes = (orgKeyHashes.results ?? []).map((row) => row.key_hash);
    let refreshFailures: unknown[] = [];
    for (let attempt = 0; attempt < 3 && pendingHashes.length > 0; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
      const results = await Promise.allSettled(
        pendingHashes.map((hash) => refreshApiKeyCache(db, c.var.kv.apiKeys, hash))
      );
      const stillPending: string[] = [];
      refreshFailures = [];
      results.forEach((result, index) => {
        const hash = pendingHashes[index];
        if (hash === undefined) {
          return;
        }
        if (result.status === "rejected") {
          stillPending.push(hash);
          refreshFailures.push(result.reason);
        } else if (!result.value) {
          // A false return means CAS contention left a possibly-stale entry
          // cached — as unresolved as a thrown write error.
          stillPending.push(hash);
          refreshFailures.push(new Error("api key cache refresh remained contended"));
        }
      });
      pendingHashes = stillPending;
    }

    if (pendingHashes.length > 0) {
      getLogger().error(
        { errors: refreshFailures },
        "Failed to invalidate cached API keys after organization deletion"
      );
      failures.push(...refreshFailures);
    }
  } catch (error) {
    // Enumerating the keys is itself post-commit work: losing it must not
    // cost the session revocation below.
    getLogger().error({ error }, "Failed to enumerate API keys after organization deletion");
    failures.push(error);
  }

  try {
    await new SessionService(db).revokeOrganizationSessions(orgId);
  } catch (error) {
    getLogger().error({ error }, "Failed to revoke sessions after organization deletion");
    failures.push(error);
  }

  try {
    await new AuditService(getDb(c.env)).log(c, {
      action: "delete",
      resourceType: "organization",
      resourceId: orgId,
    });
  } catch (error) {
    // A missing audit record does not leave a credential live, so it is
    // logged rather than retried by the caller.
    getLogger().error({ error }, "Failed to audit an organization deletion that already committed");
  }

  if (failures.length > 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Organization was deleted but some credentials could not be invalidated yet; the reconciliation job repairs cached API keys automatically"
    );
  }

  return noContent(c);
};
