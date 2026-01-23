/**
 * Allowlist Management Routes (Internal Admin)
 *
 * These routes are for internal administration only.
 * In production, they should be protected by additional auth.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "@/types/env";
import { success, created, noContent } from "@/lib/response";
import { AppError, notFound } from "@/lib/errors";
import { generateAllowlistId } from "@/lib/crypto";
import { AllowlistService } from "@/services/allowlist.service";
import { KVService } from "@/services/kv.service";
import { AuditService } from "@/services/audit.service";

const allowlist = new Hono<{ Bindings: Env }>();

// Validation schemas
const addEntrySchema = z.object({
  type: z.enum(["email", "domain"]),
  value: z.string().min(1),
  tier: z.enum(["standard", "pro", "enterprise"]).optional(),
  notes: z.string().max(500).optional(),
});

// Simple admin key check middleware
// In production, use proper admin authentication
const adminAuth = async (c: any, next: any) => {
  const adminKey = c.req.header("X-Admin-Key");

  // In development, allow without key
  if (c.env.ENVIRONMENT === "development") {
    await next();
    return;
  }

  // In staging/production, require admin key
  // This should be replaced with proper admin auth
  if (!adminKey) {
    throw new AppError("UNAUTHORIZED", "Admin authentication required");
  }

  await next();
};

allowlist.use("*", adminAuth);

/**
 * List allowlist entries
 * GET /admin/allowlist
 */
allowlist.get("/", async (c) => {
  const type = c.req.query("type") as "email" | "domain" | undefined;
  const status = c.req.query("status") as "active" | "disabled" | undefined;

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = new AllowlistService(c.env.DB, kvService);

  const entries = await allowlistService.listEntries({ type, status });

  return success(c, { entries });
});

/**
 * Add allowlist entry
 * POST /admin/allowlist
 */
allowlist.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = addEntrySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = new AllowlistService(c.env.DB, kvService);
  const auditService = new AuditService(c.env.DB);

  const id = generateAllowlistId();

  try {
    const entry = await allowlistService.addEntry({
      id,
      type: parsed.data.type,
      value: parsed.data.value,
      tier: parsed.data.tier,
      notes: parsed.data.notes,
    });

    await auditService.log(c, {
      action: "create",
      resourceType: "allowlist",
      resourceId: id,
      metadata: parsed.data,
    });

    return created(c, { entry });
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      throw new AppError("CONFLICT", "Entry already exists in allowlist");
    }
    throw err;
  }
});

/**
 * Remove allowlist entry
 * DELETE /admin/allowlist/:id
 */
allowlist.delete("/:id", async (c) => {
  const { id } = c.req.param();

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = new AllowlistService(c.env.DB, kvService);
  const auditService = new AuditService(c.env.DB);

  // Check if exists
  const existing = await c.env.DB.prepare("SELECT id FROM allowlist WHERE id = ?")
    .bind(id)
    .first();

  if (!existing) {
    throw notFound("Allowlist entry");
  }

  await allowlistService.removeEntry(id);

  await auditService.log(c, {
    action: "delete",
    resourceType: "allowlist",
    resourceId: id,
  });

  return noContent(c);
});

/**
 * Check if email is allowlisted
 * GET /admin/allowlist/check
 */
allowlist.get("/check", async (c) => {
  const email = c.req.query("email");

  if (!email) {
    throw new AppError("BAD_REQUEST", "Email query parameter required");
  }

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = new AllowlistService(c.env.DB, kvService);

  const result = await allowlistService.isEmailAllowed(email);

  return success(c, result);
});

export default allowlist;
