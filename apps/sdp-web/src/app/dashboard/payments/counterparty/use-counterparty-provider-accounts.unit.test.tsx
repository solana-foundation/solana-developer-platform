// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useCounterpartyProviderAccounts } from "./use-counterparty-provider-accounts";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

/** Stubs the browser's fetch (the hook's real transport) and records each URL it is asked for. */
function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ data: { accounts: [] } });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCounterpartyProviderAccounts", () => {
  it("loads provider accounts when ramps are on", async () => {
    const urls = stubFetch();
    const { result } = renderHook(
      () => useCounterpartyProviderAccounts("cpty_1", { enabled: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(urls).toEqual(["/api/dashboard/counterparty/cpty_1/provider-accounts"]);
  });

  it("makes no request when ramps are off", async () => {
    const urls = stubFetch();
    const { result } = renderHook(
      () => useCounterpartyProviderAccounts("cpty_1", { enabled: false }),
      { wrapper }
    );

    // Give SWR a tick to start a request it should never start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).toEqual([]);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
