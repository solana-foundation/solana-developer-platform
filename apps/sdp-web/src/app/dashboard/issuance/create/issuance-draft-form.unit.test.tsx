// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { IssuanceDraftForm } from "./issuance-draft-form";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard/issuance/create",
  useSearchParams: () => new URLSearchParams("step=3"),
}));
vi.mock("./actions", () => ({ saveIssuanceDraft: vi.fn() }));

function renderPermissions(
  wallets: PaymentsDashboardWallet[] = [],
  walletsError: string | null = null
) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <IssuanceDraftForm wallets={wallets} walletsError={walletsError} />
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("links to the wallet page separately and refreshes the inventory on return", () => {
  const { unmount } = renderPermissions();
  expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
  expect(screen.getByText("You need a wallet to issue a token.")).toBeTruthy();
  const link = screen.getByRole("link", { name: "Go to Wallets (opens in a new tab)" });
  expect(link.getAttribute("href")).toBe("/dashboard/wallets");
  expect(link.getAttribute("target")).toBe("_blank");
  fireEvent.focus(window);
  expect(router.refresh).toHaveBeenCalledOnce();
  unmount();
  fireEvent.focus(window);
  expect(router.refresh).toHaveBeenCalledOnce();
});

it("does not mistake a wallet lookup failure for an empty inventory", () => {
  renderPermissions([], "Unable to load wallets.");
  expect(screen.getByRole("alert").textContent).toBe("Unable to load wallets.");
  expect(screen.queryByRole("link", { name: /Go to Wallets/ })).toBeNull();
  fireEvent.focus(window);
  expect(router.refresh).not.toHaveBeenCalled();
});

it("does not show the setup prompt when wallets are available", () => {
  renderPermissions([
    { id: "cwlt_test", walletId: "provider_test", label: "Test wallet", publicKey: "address_test" },
  ]);
  expect(screen.queryByRole("link", { name: /Go to Wallets/ })).toBeNull();
  fireEvent.focus(window);
  expect(router.refresh).not.toHaveBeenCalled();
});
