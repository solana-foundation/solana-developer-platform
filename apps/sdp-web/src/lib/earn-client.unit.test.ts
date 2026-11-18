import type { Operation } from "@sdp/types/operations";
import { describe, expect, it, vi } from "vitest";
import { createEarnClient, type EarnApiError } from "./earn-client";

function operation(): Operation {
  return {
    id: "operation/with space",
    kind: "earn.deposit",
    status: "prepared",
    environment: "sandbox",
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      amount: { mint: "usdc", value: "10" },
    },
    actionId: "action-1",
    version: 1,
    nextAction: { type: "execute" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: null,
    resourceRef: null,
    result: null,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T12:00:00.000Z",
    updatedAt: "2026-11-18T12:00:00.000Z",
  };
}

describe("Earn core client", () => {
  it("prepares an owner-signed deposit without executing or adding credentials", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { operation: operation() } }));
    const client = createEarnClient(transport);
    const intent = {
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      amount: { mint: "usdc", value: "10" },
      feePayer: "partner",
    };
    await expect(client.deposit(intent, "stable-prepare-key")).resolves.toMatchObject({
      status: "prepared",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [path, init] = transport.mock.calls[0] ?? [];
    expect(path).toBe("/v1/earn/deposit");
    expect(JSON.parse(String(init.body))).toEqual(intent);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("stable-prepare-key");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("executes the exact advertised version and preserves signed bytes on retry", async () => {
    const transport = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: operation() } })
    );
    const client = createEarnClient(transport);
    const action = { actionId: "action-1", version: 1, signedTransaction: "c2lnbmVk" };
    await client.execute("operation/with space", action, "stable-submit-key");
    await client.execute("operation/with space", action, "stable-submit-key");
    expect(transport.mock.calls[0]?.[0]).toBe("/v1/operations/operation%2Fwith%20space/execute");
    expect(transport.mock.calls[0]?.[1]).toEqual(transport.mock.calls[1]?.[1]);
  });

  it("retains HTTP status and retry hints without treating failure as an empty feed", async () => {
    const client = createEarnClient(async () =>
      Response.json(
        { error: { code: "RATE_LIMITED", message: "Retry later" } },
        { status: 429, headers: { "Retry-After": "12" } }
      )
    );
    await expect(client.operations()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "Retry later",
      retryAfterSeconds: 12,
    } satisfies Partial<EarnApiError>);
  });

  it("refuses malformed successful operations before exposing an executable action", async () => {
    const client = createEarnClient(async () =>
      Response.json({ data: { operation: { id: "only-id" } } })
    );
    await expect(client.operation("operation")).rejects.toThrow();
  });

  it("requires the caller to persist an idempotency key before mutation", async () => {
    const transport = vi.fn();
    await expect(createEarnClient(transport).cancel("operation", "")).rejects.toThrow(
      "idempotency key"
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
