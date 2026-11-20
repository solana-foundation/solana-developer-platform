import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchResult } from "./payments-page.data";
import {
  fetchDashboardPaymentTransfers,
  fetchDashboardPaymentTransfersForWallets,
  fetchPaymentsWallets,
  fetchPaymentTransfers,
  WALLET_TRANSFERS_DEADLINE_MS,
} from "./payments-page.data";

describe("fetchPaymentsWallets", () => {
  it("keeps same-address Connection wallets and their execution admission", async () => {
    const wallets = [
      {
        id: "wallet-a",
        walletId: "provider-wallet",
        publicKey: "shared-address",
        label: "Treasury",
        provider: "privy",
        custodyConnectionId: "connection-a",
        isRuntimeExecutionAllowed: true,
      },
      {
        id: "wallet-b",
        walletId: "provider-wallet",
        publicKey: "shared-address",
        label: "Treasury",
        provider: "privy",
        custodyConnectionId: "connection-b",
        isRuntimeExecutionAllowed: false,
      },
    ];
    const request = vi.fn().mockResolvedValue(Response.json({ data: { wallets } }));

    const result = await fetchPaymentsWallets(request, { view: "summary" });

    expect(request).toHaveBeenCalledWith("/v1/wallets?view=summary");
    expect(result).toEqual({ ok: true, data: wallets });
  });

  it("keeps a Config wallet and its balances, asking for balances when told", async () => {
    const wallet = {
      id: "config-wallet",
      walletId: "provider-wallet",
      publicKey: "address",
      label: null,
      provider: "privy",
      custodyConfigId: "config",
      isRuntimeExecutionAllowed: false,
      balances: [{ token: "USDC", mint: "mint", amount: "1000000", uiAmount: "1", decimals: 6 }],
    };
    const request = vi.fn().mockResolvedValue(Response.json({ data: { wallets: [wallet] } }));

    expect(await fetchPaymentsWallets(request, { includeBalances: true })).toEqual({
      ok: true,
      data: [wallet],
    });
    expect(request).toHaveBeenCalledWith("/v1/wallets?includeBalances=true");
  });

  it.each([
    { name: "no owner", fields: {} },
    {
      name: "two owners",
      fields: { custodyConfigId: "config", custodyConnectionId: "connection" },
    },
    { name: "an empty owner", fields: { custodyConfigId: "" } },
    {
      name: "no execution admission",
      fields: { custodyConnectionId: "connection", isRuntimeExecutionAllowed: undefined },
    },
    {
      name: "a non-boolean execution admission",
      fields: { custodyConnectionId: "connection", isRuntimeExecutionAllowed: "true" },
    },
  ])("rejects a wallet with $name", async ({ fields }) => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          wallets: [
            {
              id: "wallet",
              walletId: "provider-wallet",
              publicKey: "address",
              isRuntimeExecutionAllowed: true,
              ...fields,
            },
          ],
        },
      })
    );

    expect(await fetchPaymentsWallets(request)).toEqual({
      ok: false,
      error: "Invalid custody wallet response",
    });
  });

  it("distinguishes an empty wallet list from missing wallet data", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { wallets: [] } }))
      .mockResolvedValueOnce(Response.json({ data: {} }));

    expect(await fetchPaymentsWallets(request)).toEqual({ ok: true, data: [] });
    expect(await fetchPaymentsWallets(request)).toEqual({
      ok: false,
      error: "Invalid custody wallet response",
    });
  });
});

function transfersResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function transferFor(custodyWalletId: string) {
  return {
    id: `transfer-${custodyWalletId}`,
    custodyWalletId,
    providerWalletId: `provider-${custodyWalletId}`,
    status: "confirmed",
    signature: `signature-${custodyWalletId}`,
    rampsMemo: {},
    createdAt: "2026-09-15T10:00:00.000Z",
  };
}

/** A request that answers only when aborted, the way a hung wallet read behaves. */
function hangingUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError"))
    );
  });
}

const twoWallets: FetchResult<PaymentsDashboardWallet[]> = {
  ok: true,
  data: [
    {
      id: "wallet-fast",
      walletId: "provider-fast",
      publicKey: "address-fast",
      label: null,
      provider: "privy",
      custodyConfigId: "config",
      isRuntimeExecutionAllowed: true,
    },
    {
      id: "wallet-slow",
      walletId: "provider-slow",
      publicKey: "address-slow",
      label: null,
      provider: "privy",
      custodyConfigId: "config",
      isRuntimeExecutionAllowed: true,
    },
  ],
};

const withDeadline = { walletDeadlineMs: WALLET_TRANSFERS_DEADLINE_MS };

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchDashboardPaymentTransfersForWallets deadline", () => {
  it("returns what arrived when a wallet misses its deadline, and aborts that read", async () => {
    vi.useFakeTimers();
    const signals = new Map<string, AbortSignal | undefined>();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      const custodyWalletId = new URL(`https://example.test${path}`).searchParams.get(
        "custodyWalletId"
      );
      if (custodyWalletId === null) return transfersResponse([]);
      signals.set(custodyWalletId, init?.signal ?? undefined);
      return custodyWalletId === "wallet-slow"
        ? hangingUntilAborted(init)
        : transfersResponse([transferFor(custodyWalletId)]);
    });

    const pending = fetchDashboardPaymentTransfersForWallets(request, twoWallets, 20, withDeadline);
    await vi.advanceTimersByTimeAsync(WALLET_TRANSFERS_DEADLINE_MS - 1);
    expect(signals.get("wallet-slow")?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      ok: true,
      walletsNotLoaded: 1,
      data: [transferFor("wallet-fast")],
    });
    expect(signals.get("wallet-slow")?.aborted).toBe(true);
    expect(signals.get("wallet-fast")?.aborted).toBe(false);
  });

  it("reports wallets that did not load even when nothing arrived", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      new URL(`https://example.test${path}`).searchParams.has("custodyWalletId")
        ? hangingUntilAborted(init)
        : transfersResponse([])
    );

    const pending = fetchDashboardPaymentTransfersForWallets(request, twoWallets, 20, withDeadline);
    await vi.advanceTimersByTimeAsync(WALLET_TRANSFERS_DEADLINE_MS);
    const result = await pending;

    // Empty, but not "no transfers": the caller is told two wallets are missing.
    expect(result).toEqual({ ok: true, data: [], walletsNotLoaded: 2 });
  });

  it("counts every wallet as loaded when all answer in time", async () => {
    const request = vi.fn(async (path: string) => {
      const custodyWalletId = new URL(`https://example.test${path}`).searchParams.get(
        "custodyWalletId"
      );
      return transfersResponse(custodyWalletId ? [transferFor(custodyWalletId)] : []);
    });

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      twoWallets,
      20,
      withDeadline
    );

    expect(result.walletsNotLoaded).toBe(0);
    expect(result.data?.map((transfer) => transfer.id).sort()).toEqual([
      "transfer-wallet-fast",
      "transfer-wallet-slow",
    ]);
  });

  // Nothing can say how many wallets are missing when the list of them failed.
  it("reports unknown coverage when the wallet list itself failed", async () => {
    const request = vi.fn(async () => transfersResponse([]));

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      { ok: false, error: "wallets unavailable" },
      20,
      withDeadline
    );

    expect(result).toEqual({ ok: true, data: [], walletsNotLoaded: null });
  });

  it("waits on every wallet when the caller sets no deadline", async () => {
    vi.useFakeTimers();
    let answerSlowWallet: (() => void) | undefined;
    const request = vi.fn(async (path: string) => {
      const custodyWalletId = new URL(`https://example.test${path}`).searchParams.get(
        "custodyWalletId"
      );
      if (custodyWalletId !== "wallet-slow") {
        return transfersResponse(custodyWalletId ? [transferFor(custodyWalletId)] : []);
      }
      return new Promise<Response>((resolve) => {
        answerSlowWallet = () => resolve(transfersResponse([transferFor(custodyWalletId)]));
      });
    });

    const pending = fetchDashboardPaymentTransfersForWallets(request, twoWallets, 20);
    await vi.advanceTimersByTimeAsync(WALLET_TRANSFERS_DEADLINE_MS * 4);
    answerSlowWallet?.();
    const result = await pending;

    expect(result.walletsNotLoaded).toBe(0);
    expect(result.data?.map((transfer) => transfer.id).sort()).toEqual([
      "transfer-wallet-fast",
      "transfer-wallet-slow",
    ]);
  });
});

describe("fetchDashboardPaymentTransfers", () => {
  it("starts the persisted-history read alongside the wallet list, not behind it", async () => {
    let answerWallets!: (response: Response) => void;
    const walletsAnswered = new Promise<Response>((resolve) => {
      answerWallets = resolve;
    });
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/v1/wallets")) return walletsAnswered;
      return transfersResponse([]);
    });

    const pending = fetchDashboardPaymentTransfers(request, 20);

    // The persisted history does not depend on the wallet list, so both reads
    // are in flight before the list answers; serializing them would add one
    // round trip to every Home activity and volume poll.
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&includeObserved=false",
      "/v1/wallets?view=summary",
    ]);

    answerWallets(Response.json({ data: { wallets: twoWallets.data } }));
    const result = await pending;

    expect(result).toEqual({ ok: true, data: [], walletsNotLoaded: 0 });
  });
});

describe("fetchDashboardPaymentTransfersForWallets", () => {
  it("keeps exact wallets when persisted history fails and observes each address once", async () => {
    const request = vi.fn(async (path: string) => {
      const query = new URL(`https://example.test${path}`).searchParams;
      const custodyWalletId = query.get("custodyWalletId");
      if (!custodyWalletId) {
        return new Response("unavailable", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: `transfer-${custodyWalletId}`,
              custodyWalletId,
              providerWalletId: `provider-wallet-${custodyWalletId}`,
              status: "confirmed",
              signature: `signature-${custodyWalletId}`,
              token: "USDC",
              amount: "1",
              rampsMemo: {},
              createdAt: "2026-07-17T15:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      {
        ok: true,
        data: [
          {
            id: "wallet-row-1",
            walletId: "wallet-1",
            publicKey: "address-1",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
          {
            id: "wallet-row-2",
            walletId: "wallet-1",
            publicKey: "address-1",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
          {
            id: "wallet-row-3",
            walletId: "wallet-3",
            publicKey: "address-2",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
        ],
      },
      20
    );

    expect(result.ok).toBe(true);
    expect(result.data?.map((transfer) => transfer.id)).toEqual([
      "transfer-wallet-row-1",
      "transfer-wallet-row-2",
      "transfer-wallet-row-3",
    ]);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&includeObserved=false",
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=wallet-row-1&includeObserved=true",
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=wallet-row-2&includeObserved=false",
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=wallet-row-3&includeObserved=true",
    ]);
  });

  it("prefers persisted exact rows over observed duplicates for a shared address", async () => {
    const request = vi.fn(async (path: string) => {
      const custodyWalletId = new URL(`https://example.test${path}`).searchParams.get(
        "custodyWalletId"
      );
      return new Response(
        JSON.stringify({
          data: [
            {
              id: custodyWalletId === "wallet-row-1" ? "observed-transfer" : "persisted-transfer",
              custodyWalletId: custodyWalletId === "wallet-row-1" ? null : "wallet-row-2",
              providerWalletId: "provider-wallet",
              status: "confirmed",
              signature: "shared-signature",
              token: "USDC",
              amount: "1",
              rampsMemo: {},
              createdAt: "2026-07-17T15:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      {
        ok: true,
        data: [
          {
            id: "wallet-row-1",
            walletId: "provider-wallet",
            publicKey: "shared-address",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
          {
            id: "wallet-row-2",
            walletId: "provider-wallet",
            publicKey: "shared-address",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
        ],
      },
      20
    );

    expect(result.data?.map(({ id, custodyWalletId }) => ({ id, custodyWalletId }))).toEqual([
      { id: "persisted-transfer", custodyWalletId: "wallet-row-2" },
    ]);
  });

  it("lists a transfer two reads returned once, and keeps history tied to no wallet", async () => {
    const exactTransfer = {
      id: "exact-transfer",
      custodyWalletId: "wallet-row-1",
      providerWalletId: "provider-wallet-1",
      status: "confirmed",
      signature: "exact-signature",
      rampsMemo: {},
      createdAt: "2026-07-17T15:00:00.000Z",
    };
    const unattributedTransfer = {
      id: "unattributed-transfer",
      custodyWalletId: null,
      providerWalletId: "provider-wallet-1",
      status: "confirmed",
      signature: "unattributed-signature",
      rampsMemo: {},
      createdAt: "2026-07-16T15:00:00.000Z",
    };
    const request = vi.fn(async (path: string) => {
      const query = new URL(`https://example.test${path}`).searchParams;
      const data = query.has("custodyWalletId")
        ? [exactTransfer]
        : [exactTransfer, unattributedTransfer];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      {
        ok: true,
        data: [
          {
            id: "wallet-row-1",
            walletId: "provider-wallet-1",
            publicKey: "address-1",
            label: null,
            isRuntimeExecutionAllowed: true,
          },
        ],
      },
      20
    );

    expect(result.data?.map((transfer) => transfer.id)).toEqual([
      "exact-transfer",
      "unattributed-transfer",
    ]);
  });
});

describe("fetchPaymentTransfers", () => {
  it("uses one bounded database-backed request for the overview preview", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await fetchPaymentTransfers(request, 5, { includeObserved: false });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/v1/payments/transfers?page=1&pageSize=5&includeObserved=false"
    );
  });

  it("keeps every field the activity list and the command center read", async () => {
    const transfer = {
      id: "transfer-sale",
      custodyWalletId: null,
      providerWalletId: "wallet-1",
      status: "completed",
      signature: "signature-1",
      type: "offramp",
      kind: "offramp",
      direction: "outbound",
      token: "USDC",
      amount: "20",
      provider: "moonpay",
      counterpartyId: "counterparty-1",
      counterpartyDisplayName: "Northstar Labs",
      providerReference: "provider-reference-1",
      deliveryMode: "crypto",
      fiatCurrency: "USD",
      fiatAmount: "20.69",
      fiatPayout: { amount: "20.82", currency: "USD", reportedAt: "2026-10-19T23:06:32.066Z" },
      rampsMemo: { note: "settled" },
      createdAt: "2026-10-19T23:00:00.000Z",
    };
    const request = vi.fn(async () => Response.json({ data: [transfer] }));

    expect(await fetchPaymentTransfers(request, 5, { includeObserved: false })).toEqual({
      ok: true,
      data: [transfer],
    });
  });

  it("returns the API's refusal with its status and message", async () => {
    const request = vi.fn(async () =>
      Response.json({ error: { message: "Transfers unavailable" } }, { status: 503 })
    );

    expect(await fetchPaymentTransfers(request, 5)).toEqual({
      ok: false,
      status: 503,
      error: "Transfers unavailable",
    });
  });

  it.each([
    { name: "no provider wallet", fields: { providerWalletId: undefined } },
    { name: "a padded provider wallet", fields: { providerWalletId: " wallet-1 " } },
    { name: "no custody wallet", fields: { custodyWalletId: undefined } },
    { name: "a blank custody wallet", fields: { custodyWalletId: "" } },
    { name: "no ramps memo", fields: { rampsMemo: undefined } },
  ])("fails the whole read closed for a transfer with $name", async ({ fields }) => {
    const request = vi.fn(async () =>
      Response.json({
        data: [
          {
            id: "transfer-1",
            custodyWalletId: "cwlt_1",
            providerWalletId: "wallet-1",
            status: "confirmed",
            signature: null,
            rampsMemo: {},
            ...fields,
          },
        ],
      })
    );

    expect(await fetchPaymentTransfers(request, 5, { includeObserved: false })).toEqual({
      ok: false,
      error: "Malformed transfer response: required fields are missing or invalid",
    });
  });
});
