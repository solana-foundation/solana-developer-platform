import type { EarnStrategy } from "@sdp/types/earn";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEarnServerIntegration } from "./earn-integration-snippets";

type IntegrationStrategy = Pick<EarnStrategy, "id" | "depositSlippage" | "withdrawalSlippage">;
const strategy: IntegrationStrategy = {
  id: "strategy",
  depositSlippage: null,
  withdrawalSlippage: null,
};

interface GeneratedIntegration {
  listEarnStrategies(): Promise<Array<{ id: string }>>;
  prepareEarnDeposit(input: {
    ownerAddress: string;
    amount: { mint: string; value: string };
    idempotencyKey: string;
    slippageBps?: number;
    feePayer?: string;
  }): Promise<unknown>;
  getEarnOperation(operationId: string): Promise<unknown>;
  submitEarnOperation(input: {
    operationId: string;
    actionId: string;
    version: number;
    signedTransaction?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  listEarnPositions(ownerAddress: string): Promise<unknown[]>;
  listEarnActivity(ownerAddress: string): Promise<unknown[]>;
  cancelEarnOperation(operation: { id: string; canCancel: boolean }, key: string): Promise<unknown>;
  refreshEarnOperation(input: {
    operationId: string;
    actionId: string;
    version: number;
    optionId?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
}

async function loadGeneratedIntegration(): Promise<GeneratedIntegration> {
  const source = buildEarnServerIntegration(strategy, "https://api.test");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${crypto.randomUUID()}`
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SDP_API_KEY;
});

/** Route the global fetch through a fake that reads the request URL as a string. */
function stubFetch(fake: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => fake(String(input), init));
}

describe("Earn integration module", () => {
  it("uses four core Earn routes and one shared operation lifecycle", () => {
    const source = buildEarnServerIntegration(strategy);
    expect(source).toContain("/v1/earn/discovery");
    expect(source).toContain("/v1/earn/positions");
    expect(source).toContain("/v1/earn/deposit");
    expect(source).toContain("/v1/earn/withdraw");
    expect(source).not.toMatch(
      /\/v1\/earn\/external-wallet\/|vault-deposits|deposit-transactions|\/programs/
    );
    expect(source).toContain("&discover=true");
    expect(source).toContain("discovery.unavailableStrategyCount");
  });

  it("prepares without executing and keeps the key server-side", async () => {
    process.env.SDP_API_KEY = "server-secret";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "prepared" } } })
    );
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    await expect(
      integration.prepareEarnDeposit({
        ownerAddress: "owner",
        amount: { mint: "usdc", value: "10" },
        idempotencyKey: "persisted",
        feePayer: "partner",
      })
    ).resolves.toEqual({ id: "operation", status: "prepared" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.test/v1/earn/deposit");
    expect(JSON.parse(String(init?.body))).toEqual({
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      amount: { mint: "usdc", value: "10" },
      feePayer: "partner",
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret");
    expect(init?.body).not.toContain("server-secret");
  });

  it("sends a zero slippage, omits an absent fee payer and marks only a body as JSON", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "prepared" } } })
    );
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    await integration.prepareEarnDeposit({
      ownerAddress: "owner",
      amount: { mint: "usdc", value: "10" },
      idempotencyKey: "persisted",
      slippageBps: 0,
    });
    await integration.getEarnOperation("operation");
    const prepared = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(prepared?.body))).toEqual({
      strategyId: "strategy",
      source: { ownerAddress: "owner" },
      amount: { mint: "usdc", value: "10" },
      slippageBps: 0,
    });
    expect(new Headers(prepared?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(prepared?.headers).get("Idempotency-Key")).toBe("persisted");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Content-Type")).toBe(false);
  });

  it("replays exactly the signed action, version and original key", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "submitted" } } })
    );
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    const input = {
      operationId: "operation/one",
      actionId: "action",
      version: 2,
      signedTransaction: "signed",
      idempotencyKey: "persisted",
    };
    await integration.submitEarnOperation(input);
    await integration.submitEarnOperation(input);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.test/v1/operations/operation%2Fone/submit"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      actionId: "action",
      version: 2,
      signedTransaction: "signed",
    });
  });

  it("refuses truncated catalogue pagination", async () => {
    process.env.SDP_API_KEY = "key";
    stubFetch(
      vi.fn(async () => Response.json({ data: { strategies: [{ id: "one" }], total: 2 } }))
    );
    const integration = await loadGeneratedIntegration();
    await expect(integration.listEarnStrategies()).rejects.toThrow("Incomplete strategy catalogue");
  });

  it("does not send cancellation when SDP forbids it, even for a refreshed preparation", async () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    await expect(
      integration.cancelEarnOperation({ id: "operation", canCancel: false }, "key")
    ).rejects.toThrow("cannot be cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepares a selected route with its current version before submission", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "prepared" } } })
    );
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    await integration.refreshEarnOperation({
      operationId: "operation/one",
      actionId: "choice-action",
      version: 1,
      optionId: "delayed",
      idempotencyKey: "persisted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.test/v1/operations/operation%2Fone/refresh"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      actionId: "choice-action",
      version: 1,
      optionId: "delayed",
    });
  });

  it("preserves owner scope on every operation page and refuses cursor cycles", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string) =>
      Response.json({ data: { operations: [{ id: "one" }], nextCursor: "repeated" } })
    );
    stubFetch(fetchMock);
    const integration = await loadGeneratedIntegration();
    await expect(integration.listEarnActivity("owner/one")).rejects.toThrow(
      "Pagination did not advance"
    );
    expect(fetchMock.mock.calls.every(([path]) => path.includes("ownerAddress=owner%2Fone"))).toBe(
      true
    );
  });
});
