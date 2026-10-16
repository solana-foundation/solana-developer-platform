import { afterEach, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  getConfig: () => ({
    SDP_API_BASE_URL: "https://sdp.example.invalid",
    SDP_API_KEY: "test-api-key",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "https://rpc.example.invalid",
    DEMO_STRATEGY_ID: "strategy",
  }),
  getDemoSigner: async () => ({ address: "owner" }),
  getFeePayerSigner: async () => undefined,
}));

vi.mock("./solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./solana")>()),
  assertRpcCluster: async () => undefined,
  signTransaction: async (bytes: string) => `signed:${bytes}`,
}));

import { POST as prepare } from "../src/app/api/deposits/route";
import { POST as submit } from "../src/app/api/intents/submit/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("an HTTP retry after lost submit responses preserves one deposit intent", async () => {
  let builds = 0;
  let submitCalls = 0;
  const accepted = new Map<string, string>();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/strategies")) {
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
      }
      if (path.endsWith("/deposit-transactions")) {
        builds += 1;
        return Response.json({
          data: {
            transaction: {
              transactionId: `build-${builds}`,
              transaction: `unsigned-${builds}`,
              lastValidBlockHeight: "1000",
              ownerAddress: "owner",
              provider: "kamino",
            },
          },
        });
      }
      if (path.endsWith("/deposits")) {
        submitCalls += 1;
        const key = new Headers(init?.headers).get("Idempotency-Key");
        if (!key) throw new Error("Missing submit key");
        const body = JSON.parse(String(init?.body));
        accepted.set(key, body.transactionId);
        // The API accepted the first submit. All three responses disappear.
        if (submitCalls <= 3)
          throw new TypeError("Lost response after acceptance");
        return Response.json({
          data: {
            deposit: {
              movementId: `movement-${accepted.size}`,
              status: "submitted",
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    })
  );

  const request = () =>
    new Request("https://bank.example/api/deposits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bank.example",
        "Idempotency-Key": "same-browser-intent",
      },
      body: JSON.stringify({ amount: "10" }),
    });
  const preparation = await prepare(request());
  expect(preparation.status).toBe(200);
  expect(submitCalls).toBe(0);
  const {
    data: { intent },
  } = await preparation.json();
  const submitRequest = () =>
    new Request("https://bank.example/api/intents/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bank.example",
      },
      body: JSON.stringify(intent),
    });
  expect((await submit(submitRequest())).status).toBe(500);
  expect(accepted.size).toBe(1);
  expect((await submit(submitRequest())).status).toBe(200);
  expect(builds).toBe(1);
  expect(accepted.size).toBe(1);
});
