import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TIERS,
  type Organization,
  type OrganizationSettings,
  type OrganizationStatus,
  type OrganizationTier,
} from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getAuth } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { noContent, success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import {
  assertProviderAvailable,
  getProviderAvailability,
} from "@/services/provider-availability.service";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import { updateOrgSchema } from "./schemas";

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

export const updateOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const body = await c.req.json();
  const parsed = updateOrgSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const settingsPatch = parsed.data.settings;

  if (parsed.data.name === undefined && settingsPatch === undefined) {
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

    if (parsed.data.name !== undefined) {
      updates.push("name = ?");
      params.push(parsed.data.name);
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
    metadata: { ...parsed.data, ...(settingsPatch ? { settings: settingsPatch } : {}) },
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

  const sessionService = new SessionService(db);
  await sessionService
    .revokeOrganizationSessions(orgId)
    .catch((error) =>
      getLogger().error({ error }, "Failed to revoke sessions after organization deletion")
    );

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "organization",
    resourceId: orgId,
  });

  return noContent(c);
};
