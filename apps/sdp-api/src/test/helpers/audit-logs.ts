import { z } from "zod";
import type { DatabaseClient } from "@/db/client";

/** The audit actions recorded against one resource, oldest first. */
export async function readAuditActions(
  db: DatabaseClient,
  resource: { type: string; id: string }
): Promise<string[]> {
  const rows = await db.queryMany(
    "SELECT action FROM audit_logs WHERE resource_type = ? AND resource_id = ? ORDER BY created_at, id",
    [resource.type, resource.id]
  );
  return z
    .array(z.object({ action: z.string() }))
    .parse(rows)
    .map((row) => row.action);
}
