// @vitest-environment jsdom

/**
 * Settling, cancelling, funding and reclaiming.
 *
 * Successful and failed action outcomes, and what each request carries.
 */

import { DVP_CLOSE_REFUSAL, DVP_LEG_REFUSAL } from "@sdp/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useDvpTradeActions } from "./use-dvp-trade-actions";

// The hook confirms each outcome in words, so it needs the catalog those words
// come from — the same provider the surfaces rendering it already sit inside.
function withI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const originalFetch = global.fetch;

/**
 * What a close, fund or reclaim answers with: the transaction it broadcast. A
 * close also says whether it confirmed; a leg action ignores the field.
 */
const BROADCAST = {
  data: { tradeId: "dvp_1", action: "settle", signature: "sig_close", confirmed: true },
};

function respond(status: number, body: unknown = status < 300 ? BROADCAST : {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("useDvpTradeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refreshes the page after a successful settle", async () => {
    global.fetch = respond(200) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("surfaces the API's own message on a failure", async () => {
    global.fetch = respond(409, { error: { message: "Leg already funded." } }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("fund", { side: "a", walletId: "cwlt_shown_a", symbol: "USDC" })
    );

    expect(toast.error).toHaveBeenCalledWith(
      "Leg already funded.",
      expect.objectContaining({ position: "bottom-right" })
    );
  });

  it("reports a transport failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("socket hang up")) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    expect(toast.error).toHaveBeenCalledWith(
      "socket hang up",
      expect.objectContaining({ position: "bottom-right" })
    );
    expect(result.current.pending.size).toBe(0);
  });

  // A trade id goes into the path, so it is encoded rather than interpolated.
  it("encodes the trade id into the request path", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp/1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    expect(fetchMock.mock.calls[0][0]).toBe("/api/dashboard/markets/dvp/trades/dvp%2F1/settle");
  });

  // The unified fund endpoint names the leg it moves; the action is the same
  // whatever the side, so settle and cancel carry no body.
  it("sends the side and exact displayed wallet in the fund request body", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("fund", { side: "b", walletId: "cwlt_shown_b", symbol: "USDC" })
    );

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ side: "b", walletId: "cwlt_shown_b" });
  });

  describe.each(["fund", "reclaim"] as const)("%s wallet selection", (action) => {
    it.each([undefined, null, ""])(
      "never submits an implicit leg request for a missing wallet ID: %s",
      async (walletId) => {
        const fetchMock = respond(200);
        global.fetch = fetchMock as never;
        const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
          wrapper: withI18n,
        });

        await act(
          async () =>
            await result.current.act(action, { side: "a", walletId, symbol: "USDC" } as never)
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalled();
        expect(result.current.pending.size).toBe(0);
      }
    );
  });

  it("sends no body for settle", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(init.body).toBeUndefined();
  });

  // The API message names the trade id, the wallet and the mint. The toast
  // names the token and what to do about it.
  it.each([
    ["USDC", "This wallet doesn't hold any USDC yet. Send it some, then fund the leg."],
    [null, "This wallet doesn't hold this token yet. Send it some, then fund the leg."],
  ] as const)("says in plain words that the wallet holds no %s", async (symbol, copy) => {
    global.fetch = respond(400, {
      error: {
        message: "DvP trade dvp_1: wallet 5vJR… holds no ns7Y… token account",
        details: { reason: DVP_LEG_REFUSAL.walletHoldsNoToken },
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () => await result.current.act("fund", { side: "a", walletId: "cwlt_shown_a", symbol })
    );

    expect(toast.error).toHaveBeenCalledWith(copy, expect.anything());
  });

  // The copy map is exhaustive at compile time; this checks a reclaim refusal
  // reaches its own words through the same path fund's do.
  it("names a reclaim refusal in plain words", async () => {
    global.fetch = respond(409, {
      error: {
        message: "DvP trade dvp_1: this leg's escrow holds nothing to reclaim",
        details: { reason: DVP_LEG_REFUSAL.nothingToReclaim },
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("reclaim", { side: "a", walletId: "cwlt_shown_a", symbol: "USDC" })
    );

    expect(toast.error).toHaveBeenCalledWith(
      "This leg's escrow is already empty.",
      expect.anything()
    );
  });

  // A reason the dashboard doesn't know is not shown raw; the message is.
  it("shows the API's message, not an unknown reason code", async () => {
    global.fetch = respond(403, {
      error: {
        message: "Custody wallet is paused",
        details: { reason: "runtime_execution_paused" },
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    expect(toast.error).toHaveBeenCalledWith("Custody wallet is paused", expect.anything());
  });

  it("links the broadcast transaction from the success toast", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    global.fetch = respond(200, {
      data: { tradeId: "dvp_1", action: "settle", signature: "sig_close", confirmed: true },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    const [, options] = vi.mocked(toast.success).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(options.action.label).toBe("View transaction");
    options.action.onClick();
    expect(open).toHaveBeenCalledWith(
      "https://explorer.solana.com/tx/sig_close?cluster=devnet",
      "_blank",
      "noopener,noreferrer"
    );
  });

  // A close that went out but did not confirm within the request has not
  // settled anything yet. Saying "Trade settled" there is the wrong status.
  it.each([
    ["settle", true, "Trade settled. Both legs delivered."],
    ["settle", false, "Settlement sent. The trade updates once it confirms."],
    ["cancel", true, "Trade cancelled. Both legs refunded."],
    ["cancel", false, "Cancellation sent. The trade updates once it confirms."],
  ] as const)(
    "reports a %s with confirmed %s in its own words",
    async (action, confirmed, copy) => {
      global.fetch = respond(200, {
        data: { tradeId: "dvp_1", action, signature: "sig_close", confirmed },
      }) as never;
      const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
        wrapper: withI18n,
      });

      await act(async () => await result.current.act(action));

      expect(toast.success).toHaveBeenCalledWith(copy, expect.anything());
    }
  );

  // A close answer without the flag is not read as confirmed.
  it("reports a close answer missing its confirmation as unconfirmed", async () => {
    global.fetch = respond(200, {
      data: { tradeId: "dvp_1", action: "settle", signature: "sig_close" },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "SDP sent this but couldn't read the answer. Check the trade before trying again.",
      expect.anything()
    );
  });

  it.each([
    [
      DVP_CLOSE_REFUSAL.closeInProgress,
      "This trade is already being settled or cancelled. Check back in a moment.",
    ],
    [
      DVP_CLOSE_REFUSAL.legMoving,
      "A leg is still being funded or reclaimed. Try again once it lands.",
    ],
    [
      DVP_CLOSE_REFUSAL.closeFailedOnChain,
      "The network refused this, so nothing moved. Refresh the trade to see where it stands.",
    ],
  ] as const)("names the %s close refusal in plain words", async (reason, copy) => {
    global.fetch = respond(409, {
      error: { message: "DvP trade dvp_1: a cancel is in flight", details: { reason } },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("settle"));

    expect(toast.error).toHaveBeenCalledWith(copy, expect.anything());
  });

  it("says a leg action was refused because the trade is closing", async () => {
    global.fetch = respond(409, {
      error: {
        message: "DvP trade dvp_1: a settle is in flight on this trade; nothing was sent",
        details: { reason: DVP_LEG_REFUSAL.tradeClosing },
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(async () => await result.current.act("fund", { side: "a", symbol: "USDC" }));

    expect(toast.error).toHaveBeenCalledWith(
      "This trade is being settled or cancelled, so nothing was sent.",
      expect.anything()
    );
  });

  // A success answer with nothing readable on it says nothing about what was
  // sent. Reporting success there is a guess; the refresh shows what landed.
  it("reports an unreadable success answer as unconfirmed, not as done", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("fund", { side: "a", walletId: "cwlt_shown_a", symbol: "USDC" })
    );

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "SDP sent this but couldn't read the answer. Check the trade before trying again.",
      expect.anything()
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // A request the proxy or network retries must be answered with the first
  // result, so each press of fund or reclaim carries its own key.
  it("sends a fresh Idempotency-Key with each fund and reclaim, and none with settle", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("fund", { side: "a", walletId: "cwlt_shown_a", symbol: "USDC" })
    );
    await act(
      async () =>
        await result.current.act("reclaim", { side: "a", walletId: "cwlt_shown_a", symbol: "USDC" })
    );
    await act(async () => await result.current.act("settle"));

    const keys = fetchMock.mock.calls.map(
      ([, init]) => (init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]
    );
    expect(keys[0]).toMatch(/^dvp-fund-[0-9a-f]{32}$/);
    expect(keys[1]).toMatch(/^dvp-reclaim-[0-9a-f]{32}$/);
    expect(keys[2]).toBeUndefined();
  });

  it("reclaims the named leg through its own endpoint", async () => {
    const fetchMock = respond(200, {
      data: { tradeId: "dvp_1", leg: "b", amount: "5", signature: "sig_r" },
    });
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1", "devnet"), {
      wrapper: withI18n,
    });

    await act(
      async () =>
        await result.current.act("reclaim", { side: "b", walletId: "cwlt_shown_b", symbol: "USDC" })
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/dashboard/markets/dvp/trades/dvp_1/reclaim");
    expect(JSON.parse(init.body)).toEqual({ side: "b", walletId: "cwlt_shown_b" });
    expect(toast.success).toHaveBeenCalledWith(
      "Your deposit is on its way back.",
      expect.anything()
    );
  });
});
