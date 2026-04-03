import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, conflict, notFound } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { created, noContent, success } from "@/lib/response";
import { createAllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import { KVService } from "@/services/kv.service";
import { createOrganizationOnboardingService } from "@/services/organization-onboarding.service";
import {
  assertOrganizationProviderEnabled,
  getOrganizationProviderAvailability,
} from "@/services/organization-provider-access.service";
import type { Env } from "@/types/env";
import {
  type CreateOrganizationResponse,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TIERS,
  type Organization,
  type OrganizationSettings,
  type OrganizationStatus,
  type OrganizationTier,
} from "@sdp/types";
import type { Context } from "hono";
import { createOrgSchema, updateOrgSchema } from "./schemas";

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
    return "free";
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

function resolveOrganizationTierFromAllowlist(value: string): OrganizationTier {
  return parseOrganizationTier(value);
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

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createApiKeyMaterial(environment: "sandbox" | "production"): {
  key: string;
  prefix: string;
} {
  const envPrefix = environment === "production" ? "live" : "test";
  const randomPart = randomBase64Url(24);
  const key = `sk_${envPrefix}_${randomPart}`;
  const prefix = `sk_${envPrefix}_${randomPart.slice(0, 3)}`;
  return { key, prefix };
}

export const createOrganization = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = createOrgSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { name, email, custody, returnFullApiKey } = parsed.data;
  const registrationTokenHeader = c.req.header("x-organization-registration-token");
  const registrationToken = c.env.ORGANIZATION_REGISTRATION_TOKEN;
  const slug = parsed.data.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Initialize services
  const allowlistService = createAllowlistService(c.env);
  const auditService = new AuditService(getDb(c.env));
  const onboardingService = createOrganizationOnboardingService(c.env);

  // Organization self-registration is gated by a required pre-shared token.
  if (!registrationToken) {
    throw new AppError("FORBIDDEN", "Organization self-registration is disabled");
  }

  if (!registrationTokenHeader || registrationTokenHeader !== registrationToken) {
    throw new AppError("FORBIDDEN", "Invalid or missing registration token");
  }

  // Check allowlist
  const { allowed, tier } = await allowlistService.isEmailAllowed(email);
  if (!allowed) {
    throw new AppError("NOT_ALLOWLISTED", "Email or domain not on allowlist");
  }
  const resolvedTier = resolveOrganizationTierFromAllowlist(tier);

  // Check if slug is taken
  const existing = await getDb(c.env)
    .prepare("SELECT id FROM organizations WHERE slug = ?")
    .bind(slug)
    .first();

  if (existing) {
    throw conflict("Organization with this slug already exists");
  }

  // Create organization
  const orgId = `org_${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID()}`;
  const memberId = `mem_${crypto.randomUUID()}`;
  const apiKeyId = `key_${crypto.randomUUID()}`;

  if (custody) {
    try {
      await onboardingService.initializeCustody(orgId, slug, custody);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Custody initialization failed";
      throw new AppError("BAD_REQUEST", message);
    }
  }

  // Generate API key
  const { key, prefix } = createApiKeyMaterial("sandbox");
  const keyHash = await hashString(key, c.env.API_KEY_PEPPER);

  // Insert all records in a batch
  const batch = [
    // Organization
    getDb(c.env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(orgId, name, slug, resolvedTier),

    // User
    getDb(c.env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, ?, 0, 'active')`
      )
      .bind(userId, email.toLowerCase()),

    // Organization member (admin)
    getDb(c.env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind(memberId, orgId, userId),

    // API key
    getDb(c.env)
      .prepare(
        `INSERT INTO api_keys (id, organization_id, created_by, name, key_prefix, key_hash, role, environment, status)
       VALUES (?, ?, ?, 'Default Key', ?, ?, 'api_admin', 'sandbox', 'active')`
      )
      .bind(apiKeyId, orgId, userId, prefix, keyHash),
  ];

  try {
    await getDb(c.env).batch(batch);
  } catch (error) {
    if (custody) {
      await onboardingService.cleanupCustody(orgId);
    }
    throw error;
  }

  // Audit log
  await auditService.log(c, {
    organizationId: orgId,
    userId,
    action: "create",
    resourceType: "organization",
    resourceId: orgId,
    metadata: { name, slug, email },
  });

  const response: CreateOrganizationResponse = {
    organization: {
      id: orgId,
      name,
      slug,
      tier: resolvedTier,
      status: "active",
      settings: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    apiKey: {
      id: apiKeyId,
      keyPrefix: prefix,
      ...(returnFullApiKey ? { key } : {}),
    },
  };

  return created(c, response);
};

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
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
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
      await assertOrganizationProviderEnabled(
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
    throw new AppError("BAD_REQUEST", "No valid updates provided");
  }

  updates.push("updated_at = datetime('now')");
  params.push(orgId);

  await getDb(c.env)
    .prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

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

  const response = await getOrganizationProviderAvailability(c.env, getDb(c.env), orgId);
  return success(c, response);
};

export const deleteOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  // Soft delete
  await getDb(c.env)
    .prepare(
      `UPDATE organizations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
    )
    .bind(orgId)
    .run();

  // Revoke all API keys
  await getDb(c.env)
    .prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE organization_id = ?`
    )
    .bind(orgId)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "organization",
    resourceId: orgId,
  });

  return noContent(c);
};
