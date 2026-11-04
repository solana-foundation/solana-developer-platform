// @vitest-environment jsdom

import type { PaymentRampQuote } from "@sdp/types/payments";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useRampQuote } from "./use-ramp-quote";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const QUOTE: PaymentRampQuote = {
  id: "mp_first_sale",
  provider: "moonpay",
  status: "pending",
  deliveryMode: "hosted",
  hostedUrl: "https://sell-sandbox.moonpay.com/?externalTransactionId=xfr_first",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRampQuote", () => {
  it("drops a finished sale's quote, so the next quote's failure shows", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { quote: QUOTE, transferId: "xfr_first" } }))
      .mockResolvedValueOnce(
        Response.json({ error: { message: "MoonPay is unavailable" } }, { status: 502 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ payload }) =>
        useRampQuote({ endpoint: "/api/dashboard/quote", payload, shouldCreate: true }),
      { initialProps: { payload: { cryptoAmount: "25" } }, wrapper }
    );
    await waitFor(() => expect(result.current.quoteTransferId).toBe("xfr_first"));

    act(() => result.current.discardQuote());
    expect(result.current.quote).toBeNull();
    expect(result.current.quoteTransferId).toBeNull();

    rerender({ payload: { cryptoAmount: "30" } });
    await waitFor(() => expect(result.current.quoteCreationError).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.quote).toBeNull();
    expect(result.current.quoteCreationError?.message).toContain("MoonPay is unavailable");
  });
});
