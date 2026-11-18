import { afterEach, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  getConfig: () => ({
    SDP_API_BASE_URL: "https://sdp.example.invalid",
    SDP_API_KEY: "key",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "https://rpc.example.invalid",
    DEMO_STRATEGY_ID: "strategy",
  }),
  getDemoSigner: async () => ({ address: "owner" }),
  getFeePayerSigner: async () => undefined,
}));
const sign = vi.hoisted(() =>
  vi.fn(async (bytes: string) => `signed:${bytes}`)
);
vi.mock("./solana", async (original) => ({
  ...(await original<typeof import("./solana")>()),
  assertRpcCluster: async () => undefined,
  signTransaction: sign,
}));

import { POST as prepare } from "../src/app/api/deposits/route";
import { POST as execute } from "../src/app/api/operations/[operationId]/execute/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sign.mockClear();
});

it("prepares without signing and recovers a lost execute response through the same operation", async () => {
  let submits = 0;
  const accepted = new Set<string>();
  const bodies: string[] = [];
  const operation = {
    id: "operation",
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
    nextAction: {
      type: "sign_transaction",
      transaction: "unsigned",
      lastValidBlockHeight: "100",
      expiresAt: null,
    },
    terms: {
      expiresAt: null,
      estimate: null,
      minimum: null,
      fees: null,
      options: [],
    },
    resourceRef: null,
    result: null,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T12:00:00.000Z",
    updatedAt: "2026-11-18T12:00:00.000Z",
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/discovery"))
        return Response.json({
          data: {
            total: 1,
            strategies: [
              {
                id: "strategy",
                provider: "kamino",
                providerReference: "vault",
                name: "USDC",
                sourceKind: "defi",
                depositMints: ["usdc"],
                liquidityTerm: "instant",
                status: "active",
                hostCluster: "devnet",
                fundable: true,
                depositSlippage: null,
                withdrawalSlippage: null,
              },
            ],
          },
        });
      if (path.endsWith("/deposit"))
        return Response.json({ data: { operation } });
      if (path.endsWith("/execute")) {
        submits += 1;
        accepted.add(
          new Headers(init?.headers).get("Idempotency-Key") ?? "missing"
        );
        bodies.push(String(init?.body));
        // The economic action was accepted; all three immediate responses disappear.
        operation.status = "submitted";
        operation.version = 2;
        if (submits <= 3) throw new TypeError("Lost response after acceptance");
        return Response.json({ data: { operation } });
      }
      if (path.endsWith("/operations/operation"))
        return Response.json({ data: { operation } });
      throw new Error(`Unexpected request: ${path}`);
    })
  );
  const request = (path: string, body: unknown, key?: string) =>
    new Request(`https://bank.example${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bank.example",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  expect(
    (await prepare(request("/api/deposits", { amount: "10" }, "prepare-key")))
      .status
  ).toBe(200);
  expect(sign).not.toHaveBeenCalled();
  const action = {
    actionId: "action-1",
    version: 1,
    idempotencyKey: "execute-key",
  };
  const params = { params: Promise.resolve({ operationId: "operation" }) };
  expect(
    (
      await execute(
        request("/api/operations/operation/execute", action),
        params
      )
    ).status
  ).toBe(500);
  expect(accepted.size).toBe(1);
  expect(new Set(bodies).size).toBe(1);
  expect(
    (
      await execute(
        request("/api/operations/operation/execute", action),
        params
      )
    ).status
  ).toBe(200);
  expect(submits).toBe(3);
  expect(sign).toHaveBeenCalledTimes(1);
});

it("refuses to sign an operation belonging to a different owner", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchMock = vi.fn(async () =>
    Response.json({
      data: {
        operation: {
          id: "foreign",
          kind: "earn.deposit",
          status: "prepared",
          intent: {
            kind: "earn.deposit",
            strategyId: "strategy",
            source: { ownerAddress: "other" },
            amount: { mint: "usdc", value: "10" },
          },
          actionId: "action",
          version: 1,
          nextAction: {
            type: "sign_transaction",
            transaction: "unsigned",
            lastValidBlockHeight: "100",
            expiresAt: null,
          },
          terms: {
            expiresAt: null,
            estimate: null,
            minimum: null,
            fees: null,
            options: [],
          },
          resourceRef: null,
          result: null,
          cancelRequestedAt: null,
          error: null,
          createdAt: "2026-11-18T12:00:00Z",
          updatedAt: "2026-11-18T12:00:00Z",
        },
      },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  const response = await execute(
    new Request("https://bank.example/api/operations/foreign/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bank.example",
      },
      body: JSON.stringify({
        actionId: "action",
        version: 1,
        idempotencyKey: "key",
      }),
    }),
    { params: Promise.resolve({ operationId: "foreign" }) }
  );
  expect(response.status).toBe(500);
  expect(sign).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
