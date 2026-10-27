import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TIERS,
  type Organization,
  type OrganizationSettings,
  type OrganizationStatus,
  type OrganizationTier,
} from "@sdp/types/organizations";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { projectOrganizationSettings } from "@/lib/organization-access";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { findClerkOrganizationId } from "@/services/clerk-organization-provisioning.service";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import { getProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";
import type { updateOrgSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

export type OrganizationRow = {
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
    return projectOrganizationSettings(parsePostgresJson<OrganizationSettings>(raw));
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

export function toOrganizationResponse(row: OrganizationRow): Organization {
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

  // SDP owns the name (ADR 0012); Clerk's copy only labels the session's
  // organization switcher, so it follows the committed rename.
  if (body.name !== undefined) {
    const clerkOrganizationId = await findClerkOrganizationId(getDb(c.env), orgId);
    if (clerkOrganizationId === null) {
      throw badRequest("Organization is not linked to Clerk");
    }
    await new ClerkOrganizationsService(c.env).updateOrganizationName({
      organizationId: clerkOrganizationId,
      name: org.name,
    });
  }

  return success(c, toOrganizationResponse(org));
};

export const getOrganizationProviderAccess = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const response = await getProviderAvailability(c.env, getDb(c.env), orgId, {
    rampProviderMaturity: c.get("rampProviderMaturity"),
  });
  return success(c, response);
};
