// @vitest-environment jsdom

import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useZodForm } from "@/lib/use-zod-form";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { tokenAmountFieldsSchema } from "./token-amount-fields";
import type { TokenAmountTerms } from "./token-amount-quote.data";
import { useTokenAmountEntry } from "./use-token-amount-entry";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const MINT = requiredWellKnownMint("USDC", "devnet");
const OTHER_MINT = requiredWellKnownMint("EURC", "devnet");
const AS_OF = "2026-10-22T12:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

const scaledTerms: TokenAmountTerms = {
  mint: MINT,
  decimals: 6,
  transferFee: null,
  display: {
    rule: "scaled",
    multiplier: 2,
    newMultiplier: 2,
    newMultiplierEffectiveAt: "2026-01-01T00:00:00.000Z",
  },
};

const feeEntry = { epoch: "700", basisPoints: 100, maximumFee: "5" };
const feeTerms: TokenAmountTerms = {
  mint: MINT,
  decimals: 6,
  transferFee: { current: feeEntry, next: feeEntry },
  display: { rule: "plain" },
};

function quote(basis: TokenMovementBasis, amount: string, debit: string, credit: string) {
  return {
    mint: MINT,
    amount,
    amounts: { basis, debit, fee: "1", credit, decimals: 6 },
    feeEpoch: "700",
    asOf: AS_OF,
    expiresAt: EXPIRES_AT,
  };
}

/** Answers the terms and quote proxies, and records each quote body. */
function stubTokenRoutes(terms: TokenAmountTerms, answer: ReturnType<typeof quote>) {
  const quoteBodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/terms")) return Response.json({ data: { terms } });
    if (url.endsWith("/quote")) {
      quoteBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { quote: answer } });
    }
    return Response.json({ error: { message: `Unexpected ${url}` } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, quoteBodies };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

/** The entry inside a form that holds its fields, as the send and request forms do. */
function useAmountForm({
  mint,
  basis,
  amount,
}: {
  mint: string | null;
  basis: TokenMovementBasis;
  amount: string;
}) {
  const form = useZodForm(tokenAmountFieldsSchema, {
    amountUnit: "token",
    amount,
    displayAmount: "",
  });
  const entry = useTokenAmountEntry({
    mint,
    basis,
    fields: form.values,
    setFields: form.setFields,
  });
  return { ...entry, form };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useTokenAmountEntry", () => {
  it("reads no terms for SOL and keeps the typed token amount", () => {
    const { fetchMock } = stubTokenRoutes(scaledTerms, quote("debit", "1", "1", "1"));
    const { result } = renderHook(
      () => useAmountForm({ mint: SOL_MINT, basis: "debit", amount: "1.5" }),
      { wrapper }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.displayEntryAvailable).toBe(false);
    expect(result.current.tokenAmount).toBe("1.5");
    expect(result.current.canSubmitAt(Date.now())).toBe(true);
  });

  it("prices a display amount as a debit and sends the quote's token amount", async () => {
    const { quoteBodies } = stubTokenRoutes(scaledTerms, quote("debit", "5", "5", "4"));
    const { result } = renderHook(() => useAmountForm({ mint: MINT, basis: "debit", amount: "" }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.displayEntryAvailable).toBe(true));
    act(() => result.current.setUnit("display"));
    act(() => result.current.form.setField("displayAmount", "10"));
    // Nothing is sent until a quote for this input lands.
    expect(result.current.tokenAmount).toBe("");
    expect(result.current.quoteInFlight).toBe(true);

    await waitFor(() => expect(result.current.tokenAmount).toBe("5"));
    expect(quoteBodies).toEqual([{ displayAmount: "10", basis: "debit" }]);
    expect(result.current.quoteInFlight).toBe(false);
    expect(result.current.canSubmitAt(Date.now())).toBe(true);
  });

  // A quote's times are chain time. Checked against a browser clock an hour ahead, every
  // quote arrived expired, and the form priced it again every second.
  it("expires a quote its lifetime after it arrived, whatever the browser clock says", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(AS_OF) + 3_600_000);
    stubTokenRoutes(scaledTerms, {
      ...quote("debit", "5", "5", "4"),
      expiresAt: new Date(Date.parse(AS_OF) + 60_000).toISOString(),
    });
    const { result } = renderHook(() => useAmountForm({ mint: MINT, basis: "debit", amount: "" }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.setUnit("display");
      result.current.form.setField("displayAmount", "10");
    });
    await waitFor(() => expect(result.current.tokenAmount).toBe("5"));

    // The clock is frozen, so the quote arrived now; it is good for its 60 seconds.
    const receivedAt = Date.now();
    expect(result.current.canSubmitAt(receivedAt + 59_999)).toBe(true);
    // Past its expiry the quote's token amount is no longer the display amount.
    expect(result.current.canSubmitAt(receivedAt + 60_000)).toBe(false);
  });

  it("submits a credit quote's credit when the amount is what the recipient receives", async () => {
    stubTokenRoutes(scaledTerms, quote("credit", "12.5", "13.5", "12.5"));
    const { result } = renderHook(
      () => useAmountForm({ mint: MINT, basis: "credit", amount: "" }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.setUnit("display");
      result.current.form.setField("displayAmount", "25");
    });

    await waitFor(() => expect(result.current.tokenAmount).toBe("12.5"));
  });

  it("previews the fee of a token amount for a mint with a transfer fee", async () => {
    const { quoteBodies } = stubTokenRoutes(feeTerms, quote("credit", "100", "101", "100"));
    const { result } = renderHook(
      () => useAmountForm({ mint: MINT, basis: "credit", amount: "100" }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.quote?.amounts.debit).toBe("101"));
    expect(quoteBodies).toEqual([{ amount: "100", basis: "credit" }]);
    // A plain mint has no display entry, and the typed token amount is what is sent.
    expect(result.current.displayEntryAvailable).toBe(false);
    expect(result.current.tokenAmount).toBe("100");
  });

  it("starts over in token units when the token changes", async () => {
    stubTokenRoutes(scaledTerms, quote("debit", "5", "5", "4"));
    const { result, rerender } = renderHook(
      ({ mint }: { mint: string }) => useAmountForm({ mint, basis: "debit", amount: "3" }),
      { wrapper, initialProps: { mint: MINT } }
    );

    await waitFor(() => expect(result.current.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.setUnit("display");
      result.current.form.setField("displayAmount", "10");
    });
    rerender({ mint: OTHER_MINT });

    expect(result.current.unit).toBe("token");
    expect(result.current.form.values).toEqual({
      amountUnit: "token",
      amount: "3",
      displayAmount: "",
    });
    expect(result.current.tokenAmount).toBe("3");
  });

  // A wallet list that came back without the wallet's balances set the mint to null for a
  // moment; read as another token, it reset the entry and sent the old token amount.
  it("keeps the unit and the display amount while the mint is unknown for a moment", async () => {
    stubTokenRoutes(scaledTerms, quote("debit", "5", "5", "4"));
    const initialProps: { mint: string | null } = { mint: MINT };
    const { result, rerender } = renderHook(
      ({ mint }) => useAmountForm({ mint, basis: "debit", amount: "3" }),
      { wrapper, initialProps }
    );

    await waitFor(() => expect(result.current.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.setUnit("display");
      result.current.form.setField("displayAmount", "10");
    });
    rerender({ mint: null });
    rerender({ mint: MINT });

    expect(result.current.form.values).toEqual({
      amountUnit: "display",
      amount: "3",
      displayAmount: "10",
    });
    await waitFor(() => expect(result.current.tokenAmount).toBe("5"));
  });
});
