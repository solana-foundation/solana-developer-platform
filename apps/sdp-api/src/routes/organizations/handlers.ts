import { AppError, conflict, notFound } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { created, noContent, success } from "@/lib/response";
import { createAllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import type { CreateOrganizationResponse, Organization } from "@sdp/types";
import type { Context } from "hono";
import { createOrgSchema, updateOrgSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

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

  const { name, email } = parsed.data;
  const slug = parsed.data.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Initialize services
  const allowlistService = createAllowlistService(c.env);
  const auditService = new AuditService(c.env.DB);

  // Check allowlist
  const { allowed } = await allowlistService.isEmailAllowed(email);
  if (!allowed) {
    throw new AppError("NOT_ALLOWLISTED", "Email or domain not on allowlist");
  }
  const tier = "free";

  // Check if slug is taken
  const existing = await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ?")
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

  // Generate API key
  const { key, prefix } = createApiKeyMaterial("sandbox");
  const keyHash = await hashString(key, c.env.API_KEY_PEPPER);

  // Insert all records in a batch
  const batch = [
    // Organization
    c.env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, ?, 'active')`
    ).bind(orgId, name, slug, tier),

    // User
    c.env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, ?, 0, 'active')`
    ).bind(userId, email.toLowerCase()),

    // Organization member (owner)
    c.env.DB.prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, 'owner', 'active')`
    ).bind(memberId, orgId, userId),

    // API key
    c.env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, created_by, name, key_prefix, key_hash, role, environment, status)
       VALUES (?, ?, ?, 'Default Key', ?, ?, 'api_admin', 'sandbox', 'active')`
    ).bind(apiKeyId, orgId, userId, prefix, keyHash),
  ];

  await c.env.DB.batch(batch);

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
      tier: tier as "free" | "pro" | "enterprise",
      status: "active",
      settings: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    apiKey: {
      id: apiKeyId,
      key, // Full key - only shown once!
      keyPrefix: prefix,
    },
  };

  return created(c, response);
};

export const getOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = c.get("apiKey");

  // Verify access to this organization
  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const org = await c.env.DB.prepare(
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

  const response: Organization = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    tier: org.tier as "free" | "pro" | "enterprise",
    status: org.status as "active" | "suspended" | "deleted",
    settings: org.settings ? JSON.parse(org.settings) : null,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
  };

  return success(c, response);
};

export const updateOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = c.get("apiKey");

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

  if (parsed.data.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
  }

  if (parsed.data.settings !== undefined) {
    updates.push("settings = ?");
    params.push(JSON.stringify(parsed.data.settings));
  }

  if (updates.length === 0) {
    throw new AppError("BAD_REQUEST", "No valid updates provided");
  }

  updates.push("updated_at = datetime('now')");
  params.push(orgId);

  await c.env.DB.prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

  // Fetch updated org
  const org = await c.env.DB.prepare(
    `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
  )
    .bind(orgId)
    .first();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "organization",
    resourceId: orgId,
    metadata: parsed.data,
  });

  return success(c, org);
};

export const deleteOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = c.get("apiKey");

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  // Soft delete
  await c.env.DB.prepare(
    `UPDATE organizations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(orgId)
    .run();

  // Revoke all API keys
  await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE organization_id = ?`
  )
    .bind(orgId)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "delete",
    resourceType: "organization",
    resourceId: orgId,
  });

  return noContent(c);
};
