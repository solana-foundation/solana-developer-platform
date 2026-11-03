import { isMovementId, MOVEMENTS, type MovementId } from "@sdp/types/movements";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { parseDisabledMovements } from "@/lib/movement-control";
import { createSystemAuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

export interface ProjectMovementControl {
  disabledMovements: readonly MovementId[];
  version: number;
}

export interface ProjectMovementControlScope {
  organizationId: string;
  projectId: string;
}

interface ControlRow {
  disabled_movements: unknown;
  movement_control_version: unknown;
}

const controlVersionSchema = z.number().int().nonnegative();

function parseControl(row: ControlRow): ProjectMovementControl {
  return {
    disabledMovements: parseDisabledMovements(row.disabled_movements),
    version: controlVersionSchema.parse(row.movement_control_version),
  };
}

async function readControl(
  db: DatabaseExecutor,
  scope: ProjectMovementControlScope,
  forUpdate: boolean
): Promise<ProjectMovementControl> {
  const row = await db
    .prepare(
      `SELECT disabled_movements, movement_control_version FROM projects
        WHERE id = ? AND organization_id = ?${forUpdate ? " FOR UPDATE" : ""}`
    )
    .bind(scope.projectId, scope.organizationId)
    .first<ControlRow>();
  if (!row) throw new Error("Project not found in organization");
  return parseControl(row);
}

/** The operator's read of the current control and its re-enable version. */
export function getProjectMovementControl(
  env: Env,
  scope: ProjectMovementControlScope
): Promise<ProjectMovementControl> {
  return readControl(getDb(env), scope, false);
}

export interface ChangeProjectMovementControl extends ProjectMovementControlScope {
  movement: MovementId;
  operation: "disable" | "enable";
  operator: string;
  reason: string;
  ticket: string;
  /** Required for enable, so a stale status read cannot lift a newer stop. */
  expectedVersion?: number;
}

/** Change one start, with the project row and audit event in one transaction. */
export function changeProjectMovementControl(
  env: Env,
  input: ChangeProjectMovementControl
): Promise<ProjectMovementControl> {
  if (input.operation !== "disable" && input.operation !== "enable") {
    throw new Error("Unknown movement control operation");
  }
  if (!isMovementId(input.movement) || MOVEMENTS[input.movement].kind !== "start") {
    throw new Error("Only start movements can be disabled");
  }
  if (
    !input.organizationId.trim() ||
    !input.projectId.trim() ||
    !input.operator.trim() ||
    !input.reason.trim() ||
    !input.ticket.trim()
  ) {
    throw new Error("Operator, reason, and ticket are required");
  }
  if (input.operator.length > 128 || input.reason.length > 500 || input.ticket.length > 128) {
    throw new Error("Operator, reason, or ticket exceeds its length limit");
  }
  if (
    input.operation === "enable" &&
    !controlVersionSchema.safeParse(input.expectedVersion).success
  ) {
    throw new Error("A current expected version is required to enable a movement");
  }

  return createSystemAuditService(env).logSystemWithin(async (db) => {
    const before = await readControl(db, input, true);
    if (input.operation === "enable" && input.expectedVersion !== before.version) {
      throw new Error(`Control changed since status read (current version ${before.version})`);
    }
    const enabled = input.operation === "enable";
    const alreadyDisabled = before.disabledMovements.includes(input.movement);
    const alreadyInState = enabled ? !alreadyDisabled : alreadyDisabled;
    if (alreadyInState) return { entry: null, result: before };

    const disabledMovements = enabled
      ? before.disabledMovements.filter((movement) => movement !== input.movement)
      : [...before.disabledMovements, input.movement];
    const updated = await db
      .prepare(
        `UPDATE projects
            SET disabled_movements = ?::text[], movement_control_version = movement_control_version + 1,
                updated_at = sdp_datetime_now()
          WHERE id = ? AND organization_id = ?
          RETURNING disabled_movements, movement_control_version`
      )
      .bind(disabledMovements, input.projectId, input.organizationId)
      .first<ControlRow>();
    if (!updated) throw new Error("Project disappeared during control update");
    const after = parseControl(updated);
    return {
      entry: {
        action: "update" as const,
        resourceType: "project" as const,
        resourceId: input.projectId,
        organizationId: input.organizationId,
        status: "success" as const,
        metadata: {
          control: "disabled_movements",
          operation: input.operation,
          movement: input.movement,
          operator: input.operator.trim(),
          reason: input.reason.trim(),
          ticket: input.ticket.trim(),
          beforeVersion: before.version,
          afterVersion: after.version,
          beforeDisabledMovements: before.disabledMovements,
          afterDisabledMovements: after.disabledMovements,
        },
      },
      result: after,
    };
  });
}
