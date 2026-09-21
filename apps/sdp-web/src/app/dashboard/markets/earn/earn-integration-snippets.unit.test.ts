import type { EarnStrategy } from "@sdp/types";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEarnServerIntegration } from "./earn-integration-snippets";

type IntegrationStrategy = Pick<EarnStrategy, "id" | "depositSlippage" | "withdrawalSlippage">;

const strategy: IntegrationStrategy = {
  id: "earn_strategy_veda",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
  withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
};

type GeneratedIntegration = {
  listEarnStrategies(): Promise<Record<string, unknown>>;
  previewEarnDeposit(amount: string): Promise<Record<string, unknown>>;
  previewEarnWithdrawal(positionId: string, shares: string): Promise<Record<string, unknown>>;
  buildEarnDepositTransaction(input: {
    ownerAddress: string;
    amount: string;
    feePayer?: string;
  }): Promise<Record<string, unknown>>;
  buildEarnWithdrawalTransaction(input: {
    positionId: string;
    shares: string;
    feePayer?: string;
  }): Promise<Record<string, unknown>>;
  getEarnWithdrawalOptions(positionId: string): Promise<Record<string, unknown>>;
  previewEarnQueuedWithdrawal(input: {
    positionId: string;
    shares: string;
    discountBps: number;
    deadlineSeconds: number;
  }): Promise<Record<string, unknown>>;
  buildEarnQueuedWithdrawalRequest(input: {
    positionId: string;
    shares: string;
    discountBps: number;
    deadlineSeconds: number;
    feePayer?: string;
  }): Promise<Record<string, unknown>>;
  buildEarnQueuedWithdrawalCancellation(input: {
    withdrawalRequestId: string;
    feePayer?: string;
  }): Promise<Record<string, unknown>>;
  signEarnTransaction(
    built: Record<string, unknown>,
    customerSigner: (transaction: string) => Promise<string>,
    sponsorSigner?: (transaction: string) => Promise<string>
  ): Promise<string>;
};

async function loadGeneratedIntegration(input: IntegrationStrategy): Promise<GeneratedIntegration> {
  const source = buildEarnServerIntegration(input, "https://api.test");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const encoded = Buffer.from(output).toString("base64");
  return (await import(
    `data:text/javascript;base64,${encoded}#${crypto.randomUUID()}`
  )) as GeneratedIntegration;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SDP_API_KEY;
});

describe("generated Embedded Yield integration", () => {
  it("executes Veda quote and sponsor-ready build requests with the documented shapes", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ path, body });
        if (path.endsWith("vault-deposit-previews")) {
          return Response.json({
            data: { sharesOut: "1", shareDecimals: 6, blockingIssues: [] },
          });
        }
        if (path.endsWith("withdrawal-previews")) {
          return Response.json({
            data: { assetsOut: "0.5", assetDecimals: 6, blockingIssues: [] },
          });
        }
        const feePayer = requests.at(-1)?.body.feePayer;
        return Response.json({
          data: {
            transaction: {
              transactionId: path.includes("deposit") ? "deposit-build" : "withdrawal-build",
              transaction: "base64-transaction",
              ...(typeof feePayer === "string" ? { feePayer } : {}),
            },
          },
        });
      })
    );

    const generated = await loadGeneratedIntegration(strategy);
    const deposit = await generated.buildEarnDepositTransaction({
      ownerAddress: "customer",
      amount: "1",
      feePayer: "sponsor",
    });
    expect(deposit).toMatchObject({ transactionId: "deposit-build" });
    await expect(
      generated.signEarnTransaction(
        deposit,
        async (transaction) => `${transaction}:customer`,
        async (transaction) => `${transaction}:sponsor`
      )
    ).resolves.toBe("base64-transaction:customer:sponsor");
    await expect(
      generated.signEarnTransaction(deposit, async (transaction) => `${transaction}:customer`)
    ).rejects.toThrow("Sponsor signature is required");
    await expect(
      generated.buildEarnWithdrawalTransaction({
        positionId: "position",
        shares: "0.5",
        feePayer: "sponsor",
      })
    ).resolves.toMatchObject({ transactionId: "withdrawal-build" });

    expect(requests).toEqual([
      {
        path: "/v1/earn/vault-deposit-previews",
        body: { strategyId: strategy.id, amount: "1" },
      },
      {
        path: "/v1/earn/external-wallet/deposit-transactions",
        body: {
          strategyId: strategy.id,
          ownerAddress: "customer",
          amount: "1",
          feePayer: "sponsor",
          minSharesOut: "0.999",
        },
      },
      {
        path: "/v1/earn/external-wallet/withdrawal-previews",
        body: { positionId: "position", shares: "0.5" },
      },
      {
        path: "/v1/earn/external-wallet/withdrawal-transactions",
        body: {
          positionId: "position",
          shares: "0.5",
          feePayer: "sponsor",
          minAmountOut: "0.4995",
        },
      },
    ]);
  });

  it("floors a trailing-zero-padded quote like the canonical rule and still refuses over-scale precision", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ path, body });
        if (path.endsWith("vault-deposit-previews")) {
          return Response.json({
            // Padded past the mint's own scale — providers do not canonicalize.
            data: { sharesOut: "1.2000000", shareDecimals: 6, blockingIssues: [] },
          });
        }
        if (path.endsWith("withdrawal-previews")) {
          return Response.json({
            // One more SIGNIFICANT digit than the mint has atoms: malformed.
            data: { assetsOut: "1.2345671", assetDecimals: 6, blockingIssues: [] },
          });
        }
        return Response.json({
          data: { transaction: { transactionId: "build", transaction: "base64-transaction" } },
        });
      })
    );

    const generated = await loadGeneratedIntegration(strategy);

    // 1.2 at scale 6 floored by 10 bps is 1.1988 — the padded quote must read
    // as the same 1200000 atoms the canonical dashboard rule derives.
    await expect(
      generated.buildEarnDepositTransaction({ ownerAddress: "customer", amount: "1" })
    ).resolves.toMatchObject({ transactionId: "build" });
    const depositFloor = requests.find(({ path }) => path.endsWith("deposit-transactions"))?.body
      .minSharesOut;
    expect(depositFloor).toBe("1.1988");

    // A genuinely finer quote is still a thrown error, never a miscount.
    await expect(
      generated.buildEarnWithdrawalTransaction({ positionId: "position", shares: "1" })
    ).rejects.toThrow("provider quote is not a valid decimal at the reported mint scale");
  });

  it("executes the wallet-paid Kamino build without quote calls or a fee payer", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        requests.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({
          data: { transaction: { transactionId: "build", transaction: "base64-transaction" } },
        });
      })
    );

    const generated = await loadGeneratedIntegration({
      ...strategy,
      depositSlippage: null,
      withdrawalSlippage: null,
    });
    await generated.buildEarnDepositTransaction({ ownerAddress: "customer", amount: "1" });

    expect(requests).toEqual([
      {
        path: "/v1/earn/external-wallet/deposit-transactions",
        body: { strategyId: strategy.id, ownerAddress: "customer", amount: "1" },
      },
    ]);
  });

  it("needs only the strategy id and ships the previews for every provider", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        requests.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ data: { assetsOut: "1", assetDecimals: 6, blockingIssues: [] } });
      })
    );
    const source = buildEarnServerIntegration(
      { ...strategy, depositSlippage: null, withdrawalSlippage: null },
      "https://api.test"
    );
    expect(source).toContain(`const STRATEGY_ID = "${strategy.id}";`);
    expect(source).not.toContain("sourceTokenMint");
    expect(source).not.toContain("EMBEDDED_YIELD_STRATEGY");
    // No floor is required, so the floor arithmetic stays out of the module.
    expect(source).not.toContain("floorForTolerance");

    const generated = await loadGeneratedIntegration({
      ...strategy,
      depositSlippage: null,
      withdrawalSlippage: null,
    });
    await generated.previewEarnDeposit("1");
    await generated.previewEarnWithdrawal("position", "1");
    expect(requests).toEqual([
      { path: "/v1/earn/vault-deposit-previews", body: { strategyId: strategy.id, amount: "1" } },
      {
        path: "/v1/earn/external-wallet/withdrawal-previews",
        body: { positionId: "position", shares: "1" },
      },
    ]);
  });

  it("includes SDP status and error code in setup failures", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "INSUFFICIENT_PERMISSIONS", message: "earn:read is required" } },
          { status: 403 }
        )
      )
    );

    const generated = await loadGeneratedIntegration(strategy);

    await expect(generated.listEarnStrategies()).rejects.toThrow(
      "SDP 403 INSUFFICIENT_PERMISSIONS: earn:read is required"
    );
  });

  it("generates explicit queued request and post-deadline recovery calls", async () => {
    process.env.SDP_API_KEY = "sk_test_example";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ path, body });
        return Response.json({ data: { transaction: { transactionId: "queue-build" } } });
      })
    );
    const generated = await loadGeneratedIntegration(strategy);

    await generated.buildEarnQueuedWithdrawalRequest({
      positionId: "position",
      shares: "2",
      discountBps: 25,
      deadlineSeconds: 600,
      feePayer: "sponsor",
    });
    await generated.buildEarnQueuedWithdrawalCancellation({
      withdrawalRequestId: "request_1",
      feePayer: "sponsor",
    });

    expect(requests).toEqual([
      {
        path: "/v1/earn/external-wallet/withdrawal-request-transactions",
        body: {
          positionId: "position",
          shares: "2",
          discountBps: 25,
          deadlineSeconds: 600,
          feePayer: "sponsor",
        },
      },
      {
        path: "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
        body: { withdrawalRequestId: "request_1", feePayer: "sponsor" },
      },
    ]);
  });
});
