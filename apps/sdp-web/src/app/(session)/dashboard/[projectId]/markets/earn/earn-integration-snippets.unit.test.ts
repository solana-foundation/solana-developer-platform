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
    feePayer?: string;
  }): Promise<unknown>;
  executeEarnOperation(input: {
    operationId: string;
    actionId: string;
    version: number;
    signedTransaction?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  listEarnPositions(ownerAddress: string): Promise<unknown[]>;
  listEarnActivity(ownerAddress: string): Promise<unknown[]>;
  requestEarnCancellation(operationId: string, key: string): Promise<unknown>;
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
  vi.unstubAllGlobals();
  delete process.env.SDP_API_KEY;
});

describe("Earn integration module", () => {
  it("uses four core Earn routes and one shared operation lifecycle", () => {
    const source = buildEarnServerIntegration(strategy);
    expect(source).toContain("/v1/earn/discovery");
    expect(source).toContain("/v1/earn/positions");
    expect(source).toContain("/v1/earn/deposit");
    expect(source).toContain("/v1/earn/withdraw");
    expect(source).not.toMatch(/external-wallet|vault-deposits|deposit-transactions|\/programs/);
    expect(source).toContain("&discover=true");
    expect(source).toContain("discovery.unavailableStrategyCount");
  });

  it("prepares without executing and keeps the key server-side", async () => {
    process.env.SDP_API_KEY = "server-secret";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "prepared" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
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

  it("replays exactly the signed action, version and original key", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: { operation: { id: "operation", status: "submitted" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const integration = await loadGeneratedIntegration();
    const input = {
      operationId: "operation/one",
      actionId: "action",
      version: 2,
      signedTransaction: "signed",
      idempotencyKey: "persisted",
    };
    await integration.executeEarnOperation(input);
    await integration.executeEarnOperation(input);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.test/v1/operations/operation%2Fone/execute"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      actionId: "action",
      version: 2,
      signedTransaction: "signed",
    });
  });

  it("refuses truncated catalogue pagination", async () => {
    process.env.SDP_API_KEY = "key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { strategies: [{ id: "one" }], total: 2 } }))
    );
    const integration = await loadGeneratedIntegration();
    await expect(integration.listEarnStrategies()).rejects.toThrow("Incomplete strategy catalogue");
  });

  it("preserves owner scope on every operation page and refuses cursor cycles", async () => {
    process.env.SDP_API_KEY = "key";
    const fetchMock = vi.fn(async (_path: string) =>
      Response.json({ data: { operations: [{ id: "one" }], nextCursor: "repeated" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const integration = await loadGeneratedIntegration();
    await expect(integration.listEarnActivity("owner/one")).rejects.toThrow(
      "Pagination did not advance"
    );
    expect(fetchMock.mock.calls.every(([path]) => path.includes("ownerAddress=owner%2Fone"))).toBe(
      true
    );
  });
});
