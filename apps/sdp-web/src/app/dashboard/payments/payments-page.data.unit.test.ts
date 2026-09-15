import { describe, expect, it, vi } from "vitest";
import {
  fetchDashboardPaymentTransfersForWallets,
  fetchPaymentsWallets,
  fetchPaymentTransfers,
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

    expect(request).toHaveBeenCalledWith("/v1/wallets?includeAllProviders=true&view=summary");
    expect(result).toEqual({ ok: true, data: wallets });
  });

  it("rejects a wallet response without execution admission", async () => {
    const wallet = {
      id: "config-wallet",
      walletId: "provider-wallet",
      publicKey: "address",
      label: null,
      custodyConfigId: "config",
    };
    const request = vi.fn().mockResolvedValue(Response.json({ data: { wallets: [wallet] } }));

    expect(await fetchPaymentsWallets(request)).toEqual({
      ok: false,
      error: "Invalid custody wallet response",
    });
  });

  it.each([true, false])("keeps a Config wallet with execution admission %s", async (allowed) => {
    const wallet = {
      id: "config-wallet",
      walletId: "provider-wallet",
      publicKey: "address",
      label: null,
      provider: "privy",
      custodyConfigId: "config",
      isRuntimeExecutionAllowed: allowed,
      balances: [{ token: "USDC", mint: "mint", amount: "1000000", uiAmount: "1", decimals: 6 }],
    };
    const request = vi.fn().mockResolvedValue(Response.json({ data: { wallets: [wallet] } }));

    expect(await fetchPaymentsWallets(request, { includeBalances: true })).toEqual({
      ok: true,
      data: [wallet],
    });
    expect(request).toHaveBeenCalledWith(
      "/v1/wallets?includeAllProviders=true&includeBalances=true"
    );
  });

  it.each([
    { name: "no owner", owner: {} },
    { name: "two owners", owner: { custodyConfigId: "config", custodyConnectionId: "connection" } },
    { name: "empty owner", owner: { custodyConfigId: "" } },
  ])("rejects a wallet with $name", async ({ owner }) => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          wallets: [
            {
              id: "wallet",
              walletId: "provider-wallet",
              publicKey: "address",
              isRuntimeExecutionAllowed: true,
              ...owner,
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

  it.each(["true", null, 1])("rejects non-boolean execution admission %s", async (admission) => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          wallets: [
            {
              id: "wallet",
              walletId: "provider-wallet",
              publicKey: "address",
              custodyConnectionId: "connection",
              isRuntimeExecutionAllowed: admission,
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
    expect(result.data).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(4);
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

    expect(result.data).toEqual([
      expect.objectContaining({
        id: "persisted-transfer",
        custodyWalletId: "wallet-row-2",
        signature: "shared-signature",
      }),
    ]);
  });

  it("keeps unresolved legacy history when exact wallet results are also present", async () => {
    const exactTransfer = {
      id: "exact-transfer",
      custodyWalletId: "wallet-row-1",
      providerWalletId: "provider-wallet-1",
      status: "confirmed",
      signature: "exact-signature",
      rampsMemo: {},
      createdAt: "2026-07-17T15:00:00.000Z",
    };
    const legacyTransfer = {
      id: "legacy-transfer",
      custodyWalletId: null,
      providerWalletId: "provider-wallet-1",
      status: "confirmed",
      signature: "legacy-signature",
      rampsMemo: {},
      createdAt: "2026-07-16T15:00:00.000Z",
    };
    const request = vi.fn(async (path: string) => {
      const query = new URL(`https://example.test${path}`).searchParams;
      const data = query.has("custodyWalletId") ? [exactTransfer] : [exactTransfer, legacyTransfer];
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
      "legacy-transfer",
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

  it("preserves transfer metadata used by the command center", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "transfer-1",
                custodyWalletId: null,
                providerWalletId: "wallet-1",
                status: "confirmed",
                signature: "signature-1",
                type: "onramp",
                provider: "mural",
                counterpartyId: "counterparty-1",
                counterpartyDisplayName: "Northstar Labs",
                providerReference: "provider-reference-1",
                deliveryMode: "crypto",
                fiatCurrency: "USD",
                fiatAmount: "1250",
                rampsMemo: {},
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    const result = await fetchPaymentTransfers(request, 5, { includeObserved: false });

    expect(result.data?.[0]).toMatchObject({
      custodyWalletId: null,
      providerWalletId: "wallet-1",
      provider: "mural",
      counterpartyId: "counterparty-1",
      counterpartyDisplayName: "Northstar Labs",
      providerReference: "provider-reference-1",
      deliveryMode: "crypto",
      fiatCurrency: "USD",
      fiatAmount: "1250",
    });
  });

  it.each([undefined, "", "   ", " wallet-1 "])(
    "fails closed when providerWalletId is %j",
    async (providerWalletId) => {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "transfer-1",
                  custodyWalletId: null,
                  providerWalletId,
                  status: "confirmed",
                  rampsMemo: {},
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      );

      const result = await fetchPaymentTransfers(request, 5, { includeObserved: false });

      expect(result).toEqual({
        ok: false,
        error: "Malformed transfer response: required fields are missing or invalid",
      });
    }
  );

  it("fails closed when rampsMemo is missing", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "transfer-1",
                custodyWalletId: null,
                providerWalletId: "wallet-1",
                status: "confirmed",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    const result = await fetchPaymentTransfers(request, 5, { includeObserved: false });

    expect(result).toEqual({
      ok: false,
      error: "Malformed transfer response: required fields are missing or invalid",
    });
  });

  it.each([undefined, "", "   ", " cwlt-1 ", 42])(
    "fails closed when custodyWalletId is %j",
    async (custodyWalletId) => {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "transfer-1",
                  custodyWalletId,
                  providerWalletId: "wallet-1",
                  status: "confirmed",
                  signature: null,
                  rampsMemo: {},
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      );

      const result = await fetchPaymentTransfers(request, 5, { includeObserved: false });

      expect(result).toEqual({
        ok: false,
        error: "Malformed transfer response: required fields are missing or invalid",
      });
    }
  );
});
