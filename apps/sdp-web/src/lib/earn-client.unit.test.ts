import type { EarnCorePosition } from "@sdp/types/earn-core";
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
    nextAction: { type: "submit" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: null,
    resourceRef: null,
    result: null,
    canCancel: false,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T12:00:00.000Z",
    updatedAt: "2026-11-18T12:00:00.000Z",
  };
}

describe("Earn core client", () => {
  it("reads a single position with the same source and unknown-value contract as the list", async () => {
    const position: EarnCorePosition = {
      id: "discovered/owner position",
      provider: "kamino",
      providerReference: "strategy",
      label: "Existing holding",
      tokenMint: "usdc",
      shareMint: "shares",
      source: { ownerAddress: "owner" },
      createdAt: null,
      closedAt: null,
      costBasisKnown: false,
      feeSponsored: false,
    };
    const transport = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: position })
    );
    const controller = new AbortController();
    const result = await createEarnClient(transport).position(
      position.id,
      { afterMovementIds: "movement-a,movement-b" },
      controller.signal
    );
    expect(result).toEqual(position);
    expect(result.tokenValue).toBeUndefined();
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/v1/earn/positions/discovered%2Fowner%20position?afterMovementIds=movement-a%2Cmovement-b",
      { signal: controller.signal }
    );
  });

  it("rejects malformed position detail instead of exposing a zero balance", async () => {
    const client = createEarnClient(async () => Response.json({ data: { id: "position" } }));
    await expect(client.position("position")).rejects.toThrow();
  });

  it("prepares an owner-signed deposit without submitting or adding credentials", async () => {
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

  it("submits the exact advertised version and preserves signed bytes on retry", async () => {
    const transport = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: operation() } })
    );
    const client = createEarnClient(transport);
    const action = { actionId: "action-1", version: 1, signedTransaction: "c2lnbmVk" };
    await client.submit("operation/with space", action, "stable-submit-key");
    await client.submit("operation/with space", action, "stable-submit-key");
    expect(transport.mock.calls[0]?.[0]).toBe("/v1/operations/operation%2Fwith%20space/submit");
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

  it("prepares a chosen route against the current action without submitting", async () => {
    const transport = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: operation() } })
    );
    const client = createEarnClient(transport);
    await client.refresh(
      "operation/with space",
      { actionId: "action-1", version: 1, optionId: "delayed" },
      "persisted-choice-key"
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe("/v1/operations/operation%2Fwith%20space/refresh");
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
      actionId: "action-1",
      version: 1,
      optionId: "delayed",
    });
  });

  it("refuses malformed successful operations before exposing an action", async () => {
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
