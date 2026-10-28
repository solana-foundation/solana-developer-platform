// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import * as apiKeyActions from "./actions";
import { DeleteApiKeyModal } from "./delete-api-key-modal";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function renderModal() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DeleteApiKeyModal
          keyId="key_test_1"
          keyName="Payouts worker"
          open
          onOpenChange={() => {}}
        />
      </SWRConfig>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
  vi.restoreAllMocks();
});

describe("DeleteApiKeyModal linked payments", () => {
  it("links what the key set up to this project's lists, narrowed to the key", async () => {
    const load = vi
      .spyOn(apiKeyActions, "loadApiKeyLinkedPaymentsAction")
      .mockResolvedValue({ ok: true, activeRecurringPayments: 1, openPaymentRequests: 4 });
    renderModal();

    const recurring = await screen.findByRole("link", { name: "Active recurring payments: 1" });
    expect(recurring.getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/payments/recurring?status=active&activatedByApiKeyId=key_test_1"
    );
    expect(
      screen.getByRole("link", { name: "Open payment requests: 4" }).getAttribute("href")
    ).toBe(
      "/dashboard/prj_test_sandbox/payments/requests?status=awaiting_payment&createdByApiKeyId=key_test_1"
    );
    expect(screen.getByRole("listitem").textContent).toBe(
      "Active recurring payments: 1Open payment requests: 4"
    );
    expect(load).toHaveBeenCalledWith("key_test_1");
  });

  it("alerts when the read itself rejects", async () => {
    vi.spyOn(apiKeyActions, "loadApiKeyLinkedPaymentsAction").mockRejectedValue(
      new Error("network down")
    );
    renderModal();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't check what it set up: network down"
    );
  });
});
