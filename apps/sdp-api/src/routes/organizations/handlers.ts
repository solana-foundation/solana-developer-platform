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
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  assertProviderAvailable,
  getProviderAvailability,
} from "@/services/provider-availability.service";
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
    return JSON.parse(raw) as OrganizationSettings;
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

  const updates: string[] = [];
  const params: (string | null)[] = [];

  const existing = await getDb(c.env)
    .prepare(
      `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<OrganizationRow>();

  if (!existing) {
    throw notFound("Organization");
  }

  if (parsed.data.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
  }

  if (parsed.data.settings !== undefined) {
    if (parsed.data.settings.rpcProvider) {
      await assertProviderAvailable(
        c.env,
        getDb(c.env),
        orgId,
        "rpc",
        parsed.data.settings.rpcProvider
      );
    }

    const mergedSettings: OrganizationSettings = {
      ...(parseOrganizationSettings(existing.settings) ?? {}),
      ...parsed.data.settings,
    };
    updates.push("settings = ?");
    params.push(JSON.stringify(mergedSettings));
  }

  if (updates.length === 0) {
    throw badRequest("No valid updates provided");
  }

  updates.push("updated_at = datetime('now')");
  params.push(orgId);

  await getDb(c.env)
    .prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();

  // Fetch updated org
  const org = await getDb(c.env)
    .prepare(
      `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
    )
    .bind(orgId)
    .first<OrganizationRow>();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "organization",
    resourceId: orgId,
    metadata: parsed.data,
  });

  if (!org) {
    throw notFound("Organization");
  }

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

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "organization",
    resourceId: orgId,
  });

  return noContent(c);
};
