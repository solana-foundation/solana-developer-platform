import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { createAllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import { KVService } from "@/services/kv.service";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import { addEntrySchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listEntries = async (c: AppContext) => {
  const type = c.req.query("type") as "email" | "domain" | undefined;
  const status = c.req.query("status") as "active" | "disabled" | undefined;

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = createAllowlistService(c.env, kvService);

  const entries = await allowlistService.listEntries({ type, status });

  return success(c, { entries });
};

export const addEntry = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = addEntrySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = createAllowlistService(c.env, kvService);
  const auditService = new AuditService(c.env.DB);

  try {
    const entry = await allowlistService.addEntry({
      id: `al_${crypto.randomUUID()}`,
      type: parsed.data.type,
      value: parsed.data.value,
      tier: parsed.data.tier,
      notes: parsed.data.notes,
    });

    await auditService.log(c, {
      action: "create",
      resourceType: "allowlist",
      resourceId: entry.id,
      metadata: parsed.data,
    });

    return created(c, { entry });
  } catch (err) {
    if (err instanceof Error && err.message?.includes("UNIQUE constraint")) {
      throw new AppError("CONFLICT", "Entry already exists in allowlist");
    }
    throw err;
  }
};

export const removeEntry = async (c: AppContext) => {
  const { id } = c.req.param();

  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  const allowlistService = createAllowlistService(c.env, kvService);
  const auditService = new AuditService(c.env.DB);

  const existing = await allowlistService.getEntry(id);
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
};
