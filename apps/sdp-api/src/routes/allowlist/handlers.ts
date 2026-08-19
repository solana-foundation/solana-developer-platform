import type { Context } from "hono";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { createAllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import type { addEntrySchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listEntries = async (c: AppContext) => {
  const type = c.req.query("type") as "email" | "domain" | undefined;
  const status = c.req.query("status") as "active" | "disabled" | undefined;

  const allowlistService = createAllowlistService(c.env);

  const entries = await allowlistService.listEntries({ type, status });

  return success(c, { entries });
};

export const addEntry = async (c: ValidatedBodyContext<typeof addEntrySchema>) => {
  const body = c.req.valid("json");

  const allowlistService = createAllowlistService(c.env);
  const auditService = new AuditService(getDb(c.env));

  try {
    const entry = await allowlistService.addEntry({
      id: `al_${crypto.randomUUID()}`,
      type: body.type,
      value: body.value,
      tier: body.tier ?? "standard",
      notes: body.notes,
    });

    await auditService.log(c, {
      action: "create",
      resourceType: "allowlist",
      resourceId: entry.id,
      metadata: body,
    });

    return created(c, { entry });
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      throw new AppError("CONFLICT", "Entry already exists in allowlist");
    }
    throw err;
  }
};

export const removeEntry = async (c: AppContext) => {
  const { id } = c.req.param();

  const allowlistService = createAllowlistService(c.env);
  const auditService = new AuditService(getDb(c.env));

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
