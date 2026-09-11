// @vitest-environment jsdom

/**
 * Settling, cancelling and funding.
 *
 * Three outcomes are easy to conflate and expensive to get wrong: done, held
 * for approval, and failed. A 202 in particular is the platform doing exactly
 * what the wallet policy asked, and reporting it as an error would tell an
 * operator something broke.
 */

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

function respond(status: number, body: unknown = {}) {
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
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("settle"));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(result.current.awaitingApproval).toBe(false);
  });

  // Not an error. Wallet policy is holding the action, and the page has to say
  // so rather than claiming the request failed.
  it("treats a 202 as awaiting approval, not a failure", async () => {
    global.fetch = respond(202) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("cancel"));

    expect(result.current.awaitingApproval).toBe(true);
    // Nothing landed on chain, so nothing to re-read.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces the API's own message on a failure", async () => {
    global.fetch = respond(409, { error: { message: "Leg already funded." } }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("fund", { side: "a" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Leg already funded.",
      expect.objectContaining({ position: "bottom-right" })
    );
  });

  // A body that is not JSON must still produce something an operator can act
  // on, rather than an unhandled parse error.
  it("falls back to the status when the error body is unreadable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    }) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("settle"));

    expect(toast.error).toHaveBeenCalledWith(
      "Request failed (500).",
      expect.objectContaining({ position: "bottom-right" })
    );
  });

  it("reports a transport failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("socket hang up")) as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

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
    const { result } = renderHook(() => useDvpTradeActions("dvp/1"), { wrapper: withI18n });

    await act(async () => await result.current.act("settle"));

    expect(fetchMock.mock.calls[0][0]).toBe("/api/dashboard/markets/dvp/trades/dvp%2F1/settle");
  });

  // The unified fund endpoint names the leg it moves; the action is the same
  // whatever the side, so settle and cancel carry no body.
  it("sends the side as the fund request body", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("fund", { side: "b" }));

    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(JSON.parse(init.body ?? "{}")).toEqual({ side: "b" });
  });

  it("sends no body for settle", async () => {
    const fetchMock = respond(200);
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => useDvpTradeActions("dvp_1"), { wrapper: withI18n });

    await act(async () => await result.current.act("settle"));

    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(init.body).toBeUndefined();
  });
});
