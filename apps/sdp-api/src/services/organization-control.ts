import {
  ORGANIZATION_CONTROL_SOURCE_STATUSES,
  ORGANIZATION_STATUSES,
  type OrganizationStatus,
} from "@sdp/types/organizations";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { createSystemAuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

const versionSchema = z.number().int().nonnegative().max(2_147_483_646);
const controlRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(ORGANIZATION_STATUSES),
  status_control_version: z.number().int().nonnegative(),
});

/** Organization identity, enforced status and revision required for restoration. */
export interface OrganizationControl {
  organizationId: string;
  name: string;
  status: OrganizationStatus;
  version: number;
}

function parseControl(row: z.infer<typeof controlRowSchema>): OrganizationControl {
  const parsed = controlRowSchema.parse(row);
  return {
    organizationId: parsed.id,
    name: parsed.name,
    status: parsed.status,
    version: parsed.status_control_version,
  };
}

async function readControl(
  db: DatabaseExecutor,
  organizationId: string,
  forUpdate: boolean
): Promise<OrganizationControl> {
  const row = await db
    .prepare(
      `SELECT id, name, status, status_control_version FROM organizations
        WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`
    )
    .bind(organizationId)
    .first<z.infer<typeof controlRowSchema>>();
  if (!row) throw new Error("Organization not found");
  return parseControl(row);
}

/** Read the selected deployment's organization status without changing it. */
export function getOrganizationControl(
  env: Env,
  organizationId: string
): Promise<OrganizationControl> {
  return readControl(getDb(env), organizationId, false);
}

const mutationFields = {
  organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  operator: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(4).max(200),
  ticket: z.string().regex(/^[A-Z]{2,6}-[0-9]{1,6}$/),
};

/** Restoration must name the revision read after containment. */
export const organizationControlChangeSchema = z.discriminatedUnion("operation", [
  z.object({ ...mutationFields, operation: z.literal("suspend") }).strict(),
  z
    .object({
      ...mutationFields,
      operation: z.literal("resume"),
      expectedVersion: versionSchema,
    })
    .strict(),
]);

/** Change status and append its human attribution in one ledger transaction. */
export function changeOrganizationControl(
  env: Env,
  input: z.infer<typeof organizationControlChangeSchema>
): Promise<OrganizationControl> {
  const change = organizationControlChangeSchema.parse(input);
  return createSystemAuditService(env).logSystemWithin(async (db) => {
    const before = await readControl(db, change.organizationId, true);
    const sourceStatuses: readonly OrganizationStatus[] =
      ORGANIZATION_CONTROL_SOURCE_STATUSES[change.operation];
    if (!sourceStatuses.includes(before.status)) {
      throw new Error(`Cannot ${change.operation} an organization with status ${before.status}`);
    }
    if (change.operation === "resume" && change.expectedVersion !== before.version) {
      throw new Error(`Control changed since status read (current version ${before.version})`);
    }
    const status = change.operation === "suspend" ? "suspended" : "active";
    // Repeated suspensions advance the revision too: a newer incident must
    // invalidate a restoration that is already waiting for approval.
    const updated = await db
      .prepare(
        `UPDATE organizations
            SET status = ?, status_control_version = status_control_version + 1,
                updated_at = sdp_datetime_now()
          WHERE id = ? AND status = ? AND status_control_version = ?
          RETURNING id, name, status, status_control_version`
      )
      .bind(status, change.organizationId, before.status, before.version)
      .first<z.infer<typeof controlRowSchema>>();
    if (!updated) throw new Error("Organization changed during control update");
    const after = parseControl(updated);
    return {
      entry: {
        action: "update" as const,
        resourceType: "organization" as const,
        resourceId: change.organizationId,
        organizationId: change.organizationId,
        status: "success" as const,
        metadata: {
          control: "organization_status",
          operation: change.operation,
          operator: change.operator,
          reason: change.reason,
          ticket: change.ticket,
          beforeStatus: before.status,
          afterStatus: after.status,
          beforeVersion: before.version,
          afterVersion: after.version,
        },
      },
      result: after,
    };
  });
}
