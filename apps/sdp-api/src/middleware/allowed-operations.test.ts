import {
  ALLOWED_OPERATIONS,
  isAllowedOperationsWithin,
  isOperationAllowed,
  normalizeAllowedOperations,
  OPERATION_FAMILIES,
  OPERATION_FAMILY_BY_TYPE,
  OPERATION_TYPES,
  WALLET_OPERATION_FAMILIES,
  WALLET_OPERATION_TYPES,
} from "@sdp/types";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import {
  assertOperationAllowed,
  declaredAllowedOperation,
  requireAllowedOperation,
} from "./allowed-operations";

describe("allowed operations vocabulary", () => {
  it("mirrors the wallet operation vocabulary the routes already declare", () => {
    expect([...OPERATION_TYPES].sort()).toEqual([...WALLET_OPERATION_TYPES].sort());
    expect([...OPERATION_FAMILIES].sort()).toEqual([...WALLET_OPERATION_FAMILIES].sort());
  });

  it("files every type under a known family and lists each value once", () => {
    for (const type of OPERATION_TYPES) {
      expect(OPERATION_FAMILIES).toContain(OPERATION_FAMILY_BY_TYPE[type]);
    }
    expect(new Set(ALLOWED_OPERATIONS).size).toBe(ALLOWED_OPERATIONS.length);
  });

  it("treats an empty or missing list as unrestricted", () => {
    expect(isOperationAllowed(null, "payment_transfer_execute")).toBe(true);
    expect(isOperationAllowed(undefined, "payment_transfer_execute")).toBe(true);
    expect(isOperationAllowed([], "payment_transfer_execute")).toBe(true);
  });

  it("allows a listed type or a listed family and nothing else", () => {
    expect(isOperationAllowed(["payment_transfer_execute"], "payment_transfer_execute")).toBe(true);
    expect(isOperationAllowed(["payment"], "payment_transfer_execute")).toBe(true);
    expect(isOperationAllowed(["payment"], "ramp_offramp_quote")).toBe(false);
    expect(isOperationAllowed(["issuance_mint_execute"], "issuance_burn_execute")).toBe(false);
  });

  it("decides whether one list fits inside another", () => {
    // An unrestricted grantor covers anything.
    expect(isAllowedOperationsWithin(null, ["issuance"])).toBe(true);
    expect(isAllowedOperationsWithin([], null)).toBe(true);
    // A restricted grantor cannot grant an unrestricted key.
    expect(isAllowedOperationsWithin(["payment"], [])).toBe(false);
    expect(isAllowedOperationsWithin(["payment"], null)).toBe(false);
    // A family covers its types; a type does not cover its family.
    expect(isAllowedOperationsWithin(["payment"], ["payment_transfer_execute"])).toBe(true);
    expect(isAllowedOperationsWithin(["payment"], ["payment"])).toBe(true);
    expect(isAllowedOperationsWithin(["payment_transfer_execute"], ["payment"])).toBe(false);
    expect(isAllowedOperationsWithin(["payment"], ["ramp"])).toBe(false);
    expect(isAllowedOperationsWithin(["payment"], ["payment", "issuance_mint_execute"])).toBe(
      false
    );
  });

  it("stores a list as unique sorted entries", () => {
    expect(normalizeAllowedOperations(["ramp", "payment", "ramp"])).toEqual(["payment", "ramp"]);
  });
});

describe("requireAllowedOperation", () => {
  function appWithKey(allowedOperations: unknown) {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json({ code: error.code, details: error.details ?? null }, 403)
        : c.json({ code: "UNEXPECTED" }, 500)
    );
    app.use("*", async (c, next) => {
      if (allowedOperations !== "no-key") {
        c.set("apiKey", {
          id: "key_test",
          organizationId: "org_test",
          projectId: "prj_test",
          role: "api_developer",
          permissions: ["payments:write"],
          environment: "sandbox",
          signingWalletId: null,
          allowedOperations,
        } as never);
      }
      await next();
    });
    app.post("/transfers", requireAllowedOperation("payment_transfer_execute"), (c) =>
      c.json({ ok: true })
    );
    return app;
  }

  it("lets a dashboard session through: it is not an API key", async () => {
    const response = await appWithKey("no-key").request("/transfers", { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("lets an unrestricted key through", async () => {
    for (const list of [undefined, null, []]) {
      const response = await appWithKey(list).request("/transfers", { method: "POST" });
      expect(response.status).toBe(200);
    }
  });

  it("lets a key through when the type or its family is listed", async () => {
    for (const list of [["payment"], ["payment_transfer_execute"], ["ramp", "payment"]]) {
      const response = await appWithKey(list).request("/transfers", { method: "POST" });
      expect(response.status).toBe(200);
    }
  });

  it("refuses a key whose list leaves the operation out, naming the type and family", async () => {
    const response = await appWithKey(["issuance", "ramp_onramp_quote"]).request("/transfers", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "OPERATION_NOT_ALLOWED",
      details: { operationType: "payment_transfer_execute", operationFamily: "payment" },
    });
  });

  it("exposes its declaration for the route inventory", () => {
    expect(declaredAllowedOperation(requireAllowedOperation("dvp_fund"))).toBe("dvp_fund");
    expect(declaredAllowedOperation(() => undefined)).toBeUndefined();
    expect(declaredAllowedOperation(null)).toBeUndefined();
  });

  it("assertOperationAllowed throws the same error for handler-level checks", () => {
    const c = { get: () => ({ allowedOperations: ["payment"] }) } as never;
    expect(() => assertOperationAllowed(c, "rings_shield")).toThrowError(AppError);
    expect(() => assertOperationAllowed(c, "payment_transfer_execute")).not.toThrow();
  });
});
