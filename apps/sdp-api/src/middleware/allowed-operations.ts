import { isOperationAllowed, type OperationType, operationFamilyOf } from "@sdp/types";
import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Marks a `requireAllowedOperation` handler with the operation type it
 * declares, so a route inventory test can read the declaration back.
 */
export const ALLOWED_OPERATION_MARKER = Symbol.for("sdp.allowedOperation");

/**
 * Refuse the request when the calling API key's Allowed Operations do not
 * include this operation (ADR 0006). A dashboard session or an approved
 * operation replay is not an API key and is never restricted here. An empty
 * list is unrestricted. Nothing is recorded on refusal, like a missing
 * permission.
 */
export function assertOperationAllowed(
  c: Context<{ Bindings: Env }>,
  operationType: OperationType
): void {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    return;
  }
  if (isOperationAllowed(apiKey.allowedOperations, operationType)) {
    return;
  }
  throw new AppError("OPERATION_NOT_ALLOWED", `This API key may not perform ${operationType}`, {
    operationType,
    operationFamily: operationFamilyOf(operationType),
  });
}

/**
 * Static per-route declaration of the operation a value-moving route
 * performs. Put it after `requirePermissions` and before body validation so a
 * refused key learns nothing about the body's validity.
 */
export function requireAllowedOperation(
  operationType: OperationType
): MiddlewareHandler<{ Bindings: Env }> {
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    assertOperationAllowed(c, operationType);
    await next();
  };
  return Object.assign(middleware, { [ALLOWED_OPERATION_MARKER]: operationType });
}

/** Reads the declaration a `requireAllowedOperation` handler carries. */
export function declaredAllowedOperation(handler: unknown): OperationType | undefined {
  return (handler as { [ALLOWED_OPERATION_MARKER]?: OperationType } | null)?.[
    ALLOWED_OPERATION_MARKER
  ];
}
