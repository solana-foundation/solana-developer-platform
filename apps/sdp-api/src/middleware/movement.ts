import { MOVEMENTS, type MovementId } from "@sdp/types";
import type { Context, MiddlewareHandler } from "hono";
import { type AdmittedMovement, admitMovement } from "@/lib/admit-movement";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { ALLOWED_OPERATION_MARKER, assertOperationAllowed } from "@/middleware/allowed-operations";
import type { Env } from "@/types/env";

/** Marks a {@link requireMovement} handler with the movement it declares. */
export const MOVEMENT_MARKER = Symbol.for("sdp.movement");

/**
 * The one declaration a route that moves money carries (HOO-1955). It:
 *
 * 1. refuses an API key whose Allowed Operations (ADR 0006) lack the
 *    movement's operation, exactly like `requireAllowedOperation`, and carries
 *    the same marker so the Allowed Operations inventory still reads it;
 * 2. admits the movement for the request's organization and project, before
 *    validation or any write, so a refused start leaves nothing behind;
 * 3. puts the token on the context for the handler's sinks
 *    ({@link requireAdmittedMovement}).
 *
 * Place it after `requirePermissions` and before `validateBody`, where
 * `requireAllowedOperation` goes. Routes that only need Allowed Operations
 * (quotes, records that do not sign) keep `requireAllowedOperation`.
 */
export function requireMovement(movement: MovementId): MiddlewareHandler<{ Bindings: Env }> {
  const { allowedOperation } = MOVEMENTS[movement];
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    if (allowedOperation) {
      assertOperationAllowed(c, allowedOperation);
    }
    c.set(
      "admittedMovement",
      await admitMovement(
        c.env,
        { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) },
        movement,
        { surface: "http", subjectId: c.req.path },
        { rampProviderStages: c.get("rampProviderStages") }
      )
    );
    await next();
  };
  return Object.assign(
    middleware,
    allowedOperation
      ? { [MOVEMENT_MARKER]: movement, [ALLOWED_OPERATION_MARKER]: allowedOperation }
      : { [MOVEMENT_MARKER]: movement }
  );
}

/** The token `requireMovement` admitted for this request. */
export function requireAdmittedMovement(c: Context<{ Bindings: Env }>): AdmittedMovement {
  const movement = c.get("admittedMovement");
  if (!movement) {
    throw new AppError("INTERNAL_ERROR", "Route moves money without declaring requireMovement");
  }
  return movement;
}

/** Reads the movement a `requireMovement` handler declares. */
export function declaredMovement(handler: unknown): MovementId | undefined {
  return (handler as { [MOVEMENT_MARKER]?: MovementId } | null)?.[MOVEMENT_MARKER];
}
