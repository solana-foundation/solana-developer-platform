// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useTokenActionRunner } from "./use-token-action-runner";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { loading: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const wallets: PaymentsDashboardWallet[] = [
  { id: "cwlt_a", walletId: "provider_same", publicKey: "authority", label: "Config" },
  { id: "cwlt_b", walletId: "provider_same", publicKey: "authority", label: "Connection" },
];
const fetchMock = vi.fn<typeof fetch>();
function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
beforeEach(() => {
  fetchMock
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("token action signer selection", () => {
  it("sends the only wallet without adding confirmation to an immediate action", async () => {
    const { result } = renderHook(() => useTokenActionRunner(), { wrapper });
    act(() =>
      result.current.runAction(
        { label: "Update metadata", method: "PATCH", path: "/token", body: { name: "Updated" } },
        { signerWallets: [wallets[1]] }
      )
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(result.current.actionConfirmation).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "Updated",
      signingCustodyWalletId: "cwlt_b",
    });
  });

  it("requires a choice for Unpause, then sends that exact wallet", async () => {
    const { result } = renderHook(() => useTokenActionRunner(), { wrapper });
    act(() =>
      result.current.runAction(
        { label: "Unpause", method: "POST", path: "/token/unpause", body: {} },
        { requiresConfirmation: true, signerWallets: wallets }
      )
    );
    act(() => result.current.confirmAction());
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.selectConfirmationWallet("cwlt_b"));
    act(() => result.current.confirmAction());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      signingCustodyWalletId: "cwlt_b",
    });
  });

  it("puts an allowlist removal selection in the query and preserves existing parameters", async () => {
    const { result } = renderHook(() => useTokenActionRunner(), { wrapper });
    act(() =>
      result.current.runAction(
        { label: "Remove", method: "DELETE", path: "/token/allowlist/entry?existing=1" },
        { signerWallets: wallets }
      )
    );
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.selectConfirmationWallet("cwlt_a"));
    act(() => result.current.confirmAction());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/token/allowlist/entry?existing=1&signingCustodyWalletId=cwlt_a"
    );
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });
});
