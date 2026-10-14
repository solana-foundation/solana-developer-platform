import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { SANDBOX_PROJECT } from "@/test/projects";
import { setWindowPathname } from "@/test/window-location";
import { fetchWalletBalance, fetchWalletBalances } from "./wallet-balances.data";

beforeEach(() => setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/wallets`));
afterEach(() => vi.unstubAllGlobals());

const usdcBalance = {
  token: WELL_KNOWN_TOKENS.USDC.symbol,
  mint: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
  amount: "1000000",
  uiAmount: "1",
  decimals: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].decimals,
};

describe("exact wallet balance reads", () => {
  it("reads the exact wallet under the project named by the dashboard URL", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          walletBalances: {
            custodyWalletId: "wallet-a",
            address: "address",
            balances: [],
          },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWalletBalance("wallet-a")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/payments/wallets/wallet-a/balances", {
      method: "GET",
      cache: "no-store",
      headers: new Headers({ "x-project-id": SANDBOX_PROJECT.id }),
    });
  });
  it("rejects a successful response that identifies another wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: {
              custodyWalletId: "wallet-b",
              walletId: "provider-shared",
              address: "address",
              balances: [],
            },
          },
        })
      )
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([403, 404, 503])("does not interpret HTTP %s as zero", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status }))
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([
    { custodyWalletId: undefined, address: "address", balances: [] },
    { custodyWalletId: "wallet-a", address: "address", balances: [{}] },
    { custodyWalletId: "wallet-a", address: "address", balances: "0" },
  ])("rejects missing identity and malformed balances", async (walletBalances) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { walletBalances } }))
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([
    "",
    "   ",
    " 1 ",
    "0x10",
    "0b10",
    "1e3",
    "1e-9",
    "+1",
    "-1",
    "-0",
    "Infinity",
    "NaN",
    "1.2.3",
    "9".repeat(309),
  ])("rejects invalid token balance %j instead of displaying an amount", async (uiAmount) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: {
              custodyWalletId: "wallet-a",
              address: "address",
              balances: [{ ...usdcBalance, uiAmount }],
            },
          },
        })
      )
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([
    { amount: "0", uiAmount: "0" },
    { amount: "1", uiAmount: "0.000001" },
    { amount: "1250000", uiAmount: "1.25" },
    { amount: "1250000", uiAmount: "001.2500" },
    { amount: "500000", uiAmount: ".5" },
    { amount: "1000000", uiAmount: "1." },
  ])("preserves a successful decimal token balance $uiAmount", async (amount) => {
    const balances = [{ ...usdcBalance, ...amount }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: { custodyWalletId: "wallet-a", address: "address", balances },
          },
        })
      )
    );
    await expect(fetchWalletBalance("wallet-a")).resolves.toEqual(balances);
  });
  it("keeps a successful wallet when another batch row is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { wallets: [null, { id: "wallet-a", balances: [usdcBalance] }] },
        })
      )
    );

    await expect(fetchWalletBalances()).resolves.toEqual({ "wallet-a": [usdcBalance] });
  });

  it("uses only parsed balance fields from a successful batch row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [{ id: "wallet-a", balances: [{ ...usdcBalance, unexpected: "discard" }] }],
          },
        })
      )
    );

    await expect(fetchWalletBalances()).resolves.toEqual({ "wallet-a": [usdcBalance] });
  });

  it.each([
    { balances: [usdcBalance] },
    { id: "", balances: [usdcBalance] },
    { id: 42, balances: [usdcBalance] },
    { id: "unavailable" },
    { id: "malformed", balances: "0" },
  ])(
    "omits an invalid or unavailable batch row %j without discarding successful wallets",
    async (row) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ data: { wallets: [row, { id: "wallet-a", balances: [usdcBalance] }] } })
        )
      );

      await expect(fetchWalletBalances()).resolves.toEqual({ "wallet-a": [usdcBalance] });
    }
  );

  it.each([null, {}, { data: {} }, { data: { wallets: null } }, { data: { wallets: {} } }])(
    "rejects a malformed batch envelope %j instead of returning an empty balance map",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body))
      );

      await expect(fetchWalletBalances()).rejects.toThrow(
        "Wallet balances response did not include wallets."
      );
    }
  );

  it.each([
    ["batch", fetchWalletBalances],
    ["single", () => fetchWalletBalance("wallet-a")],
  ] as const)("rejects malformed JSON at the %s read boundary", async (_read, readBalances) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { headers: { "Content-Type": "application/json" } }))
    );

    await expect(readBalances()).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    { error: { message: "RPC unavailable" } },
    { error: "RPC unavailable" },
    { message: "RPC unavailable" },
  ])("preserves a validated API error message from %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 503 }))
    );

    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow("RPC unavailable");
    await expect(fetchWalletBalances()).rejects.toThrow("RPC unavailable");
  });

  it.each([{}, { error: {} }, { error: "" }])(
    "reports HTTP failure when a valid error envelope %j has no message",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status: 503 }))
      );

      await expect(fetchWalletBalance("wallet-a")).rejects.toThrow(
        "Wallet balance request failed (503)."
      );
      await expect(fetchWalletBalances()).rejects.toThrow("Wallet balances request failed (503).");
    }
  );

  it.each([null, { error: { message: 42 } }, { message: 42 }])(
    "rejects a malformed API error envelope %j at the boundary",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status: 503 }))
      );

      await expect(fetchWalletBalance("wallet-a")).rejects.toBeInstanceOf(ZodError);
      await expect(fetchWalletBalances()).rejects.toBeInstanceOf(ZodError);
    }
  );

  it("excludes an invalid batch balance without fabricating zero or dropping a valid wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [
              { id: "wallet-a", balances: [usdcBalance] },
              { id: "wallet-b", balances: [{ ...usdcBalance, uiAmount: "0x10" }] },
            ],
          },
        })
      )
    );
    await expect(fetchWalletBalances()).resolves.toEqual({ "wallet-a": [usdcBalance] });
  });
  it("preserves a successful zero balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: {
              custodyWalletId: "wallet-a",
              walletId: "provider",
              address: "address",
              balances: [],
            },
          },
        })
      )
    );
    expect(await fetchWalletBalance("wallet-a")).toEqual([]);
  });

  it("keeps aliases with the same provider reference separate in batch results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [
              { id: "wallet-a", walletId: "shared-provider", balances: [] },
              { id: "wallet-b", walletId: "shared-provider", balances: [] },
              { id: "unavailable" },
            ],
          },
        })
      )
    );
    expect(await fetchWalletBalances()).toEqual({ "wallet-a": [], "wallet-b": [] });
  });
});
