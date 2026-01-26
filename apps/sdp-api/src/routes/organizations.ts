/**
 * Organizations Routes
 */

import {
  generateApiKey,
  generateApiKeyId,
  generateMemberId,
  generateOrgId,
  generateUserId,
  hashString,
} from "@/lib/crypto";
import { AppError, conflict, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { authMiddleware, requirePermissions } from "@/middleware/auth";
import { AllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import { KVService } from "@/services/kv.service";
import type { Env } from "@/types/env";
import type { CreateOrganizationResponse, Organization } from "@sdp/types";
import { Hono } from "hono";
import { z } from "zod";

const organizations = new Hono<{ Bindings: Env }>();

// Validation schemas
const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  email: z.string().email(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z
    .object({
      defaultEnvironment: z.enum(["sandbox", "production"]).optional(),
      allowedIpAddresses: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Create a new organization
 * POST /v1/organizations
 *
 * Requires email to be on allowlist
 */
organizations.post("/", async (c) => {
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
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = new AllowlistService(c.env.DB, kvService);
  const auditService = new AuditService(c.env.DB);

  // Check allowlist
  const { allowed, tier } = await allowlistService.isEmailAllowed(email);
  if (!allowed) {
    throw new AppError("NOT_ALLOWLISTED", "Email or domain not on allowlist");
  }

  // Check if slug is taken
  const existing = await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ?")
    .bind(slug)
    .first();

  if (existing) {
    throw conflict("Organization with this slug already exists");
  }

  // Create organization
  const orgId = generateOrgId();
  const userId = generateUserId();
  const memberId = generateMemberId();
  const apiKeyId = generateApiKeyId();

  // Generate API key
  const { key, prefix } = generateApiKey("sandbox");
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
});

// Protected routes below require authentication
organizations.use("/:orgId/*", authMiddleware());

/**
 * Get organization details
 * GET /v1/organizations/:orgId
 */
organizations.get("/:orgId", requirePermissions("org:read"), async (c) => {
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
});

/**
 * Update organization
 * PATCH /v1/organizations/:orgId
 */
organizations.patch("/:orgId", requirePermissions("org:write"), async (c) => {
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
});

/**
 * Delete organization
 * DELETE /v1/organizations/:orgId
 */
organizations.delete("/:orgId", requirePermissions("org:admin"), async (c) => {
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
});

export default organizations;
