// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useRampEstimate } from "./use-ramp-estimate";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), keepPreviousData: true, shouldRetryOnError: false }}
    >
      <I18nProvider locale="en" messages={getMessages("en")}>
        {children}
      </I18nProvider>
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ramp estimate identity", () => {
  it("clears the previous amount immediately while the next input is debounced", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { estimates: [{ provider: "coinbase", status: "unsupported" }] } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ amount }) =>
        useRampEstimate({
          direction: "onramp",
          selectedPair: { fiatCurrency: "USD", assetRail: "usdc.solana" },
          amount,
          enabled: true,
        }),
      { initialProps: { amount: "100" }, wrapper }
    );
    await act(async () => {});
    expect(result.current.estimatesByProvider.size).toBe(1);
    rerender({ amount: "200" });
    expect(result.current.estimatesByProvider.size).toBe(0);
    expect(result.current.loading).toBe(true);
    rerender({ amount: "300" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      fiatAmount: "300",
    });
    expect(result.current.estimatesByProvider.size).toBe(1);
    rerender({ amount: "" });
    expect(result.current.estimatesByProvider.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it("does not show the old corridor after the new estimate fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ data: { estimates: [{ provider: "coinbase", status: "unsupported" }] } })
        )
        .mockResolvedValue(Response.json({ error: { message: "Unavailable" } }, { status: 503 }))
    );
    const { result, rerender } = renderHook(
      ({ fiatCurrency }: { fiatCurrency: "USD" | "EUR" }) =>
        useRampEstimate({
          direction: "onramp",
          selectedPair: { fiatCurrency, assetRail: "usdc.solana" },
          amount: "100",
          enabled: true,
        }),
      { initialProps: { fiatCurrency: "USD" }, wrapper }
    );
    await act(async () => {});
    expect(result.current.estimatesByProvider.size).toBe(1);
    rerender({ fiatCurrency: "EUR" });
    await act(async () => {});
    expect(result.current.estimatesByProvider.size).toBe(0);
  });
});
