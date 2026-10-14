import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setWalletIdentityRpcMode, startWalletIdentityRpc } from "./wallet-identity-rpc";

let server: Awaited<ReturnType<typeof startWalletIdentityRpc>>;
let url: string;

beforeAll(async () => {
  server = await startWalletIdentityRpc(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture TCP address missing");
  url = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  vi.stubEnv("SOLANA_RPC_URL", url);
  await setWalletIdentityRpcMode("zero");
});
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("wallet identity read-only RPC fixture", () => {
  it.each([
    { id: 1, method: "getBalance" },
    { jsonrpc: "2.0", id: {}, method: "getBalance" },
    { jsonrpc: "2.0", id: 1, method: 42 },
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: "invalid" },
  ])("rejects a malformed JSON-RPC envelope %j", async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("serves zero balances and batched missing accounts without signing", async () => {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: "balance", method: "getBalance", params: ["wallet-a"] },
        {
          jsonrpc: "2.0",
          id: "accounts",
          method: "getMultipleAccounts",
          params: [["wallet-a", "wallet-b"], { encoding: "base64" }],
        },
      ]),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { jsonrpc: "2.0", id: "balance", result: { context: { slot: 4321 }, value: 0 } },
      {
        jsonrpc: "2.0",
        id: "accounts",
        result: { context: { slot: 4321 }, value: [null, null] },
      },
    ]);
  });

  it("returns the controlled read error in unavailable mode", async () => {
    await setWalletIdentityRpcMode("unavailable");
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance" }),
    });
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      error: { code: -32005, message: "Controlled balance read failure" },
    });
  });

  it.each(["signTransaction", "sendTransaction", "unknownMethod"])(
    "refuses the unsupported method %s",
    async (method) => {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      });
      await expect(response.json()).resolves.toMatchObject({ id: 1, error: { code: -32601 } });
    }
  );

  it("rejects malformed multiple-account parameters", async () => {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getMultipleAccounts",
        params: [[123]],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an invalid control mode without changing the fixture", async () => {
    const response = await fetch(`${url}/__wallet_identity/state`, {
      method: "POST",
      body: JSON.stringify({ mode: "sign" }),
    });
    expect(response.status).toBe(400);
    const state = await fetch(`${url}/__wallet_identity/state`);
    await expect(state.json()).resolves.toMatchObject({ fixture: "wallet-identity", mode: "zero" });
  });

  it.each([
    { fixture: "wallet-identity", mode: "zero", calls: { getBalance: "invalid" } },
    { fixture: "another-server", mode: "zero", calls: {} },
    { fixture: "wallet-identity", mode: "unavailable", calls: {} },
  ])("rejects invalid or mismatched control responses %j", async (state) => {
    const control = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(state));
    });
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = control.address();
      if (!address || typeof address === "string") throw new Error("Control TCP address missing");
      vi.stubEnv("SOLANA_RPC_URL", `http://127.0.0.1:${address.port}`);
      await expect(setWalletIdentityRpcMode("zero")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        control.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses a non-loopback control endpoint", async () => {
    vi.stubEnv("SOLANA_RPC_URL", "https://example.com");
    await expect(setWalletIdentityRpcMode("zero")).rejects.toThrow("must be on loopback");
  });
});
