import { describe, expect, it } from "vitest";
import { declaredAllowedOperation } from "@/middleware/allowed-operations";
import { declaredMovement } from "@/middleware/movement";
import custodyRoutes from "@/routes/custody";
import paymentsRoutes from "@/routes/payments";

interface RegisteredRoute {
  method: string;
  path: string;
  handler: unknown;
}

function registered(router: unknown): RegisteredRoute[] {
  return (router as { routes?: RegisteredRoute[] }).routes ?? [];
}

/**
 * Every route that moves money declares its movement (HOO-1955), and that one
 * declaration also carries its Allowed Operation (ADR 0006). This pins the
 * declarations: a new money-moving route must appear here, a route must not
 * declare two movements, and a route must not repeat its operation in a
 * separate `requireAllowedOperation`.
 */
function movements(router: unknown): Record<string, string> {
  const declared: Record<string, string> = {};
  const operationHandlers = new Map<string, unknown[]>();
  for (const route of registered(router)) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    if (declaredAllowedOperation(route.handler)) {
      operationHandlers.set(key, [...(operationHandlers.get(key) ?? []), route.handler]);
    }
    const movement = declaredMovement(route.handler);
    if (!movement) continue;
    expect(declared[key], `${key} declares two movements`).toBeUndefined();
    declared[key] = movement;
  }
  for (const key of Object.keys(declared)) {
    expect(
      (operationHandlers.get(key) ?? []).filter((handler) => !declaredMovement(handler)),
      `${key} repeats its Allowed Operation outside requireMovement`
    ).toEqual([]);
  }
  return declared;
}

describe("money movement route declarations", () => {
  it("covers every payments route that signs or sponsors", () => {
    expect(movements(paymentsRoutes)).toEqual({
      "POST /transfers": "payments.transfer",
      "POST /transfer-batches": "payments.transfer_batch",
      "PATCH /recurring-payments/:id": "recurring.update",
      "POST /recurring-payments/:id/activate": "recurring.activate",
      "POST /recurring-payments/:id/cancel": "recurring.cancel",
      "POST /recurring-payments/:id/collect": "recurring.collect",
      "POST /recurring-payments/:id/resume": "recurring.resume",
    });
  });

  it("covers the custody signer check", () => {
    expect(movements(custodyRoutes)).toEqual({
      "POST /signer-check": "custody.signer_check",
    });
  });
});
