// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace.redesign";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderWorkspace(props: Partial<ComponentProps<typeof RecurringPaymentsWorkspace>> = {}) {
  return render(
    <RecurringPaymentsWorkspace
      initialRecurringPayments={[]}
      total={0}
      listState={{ page: 1, pageSize: 25, status: null }}
      issuedTokensByMint={{}}
      wallets={[]}
      counterparties={[]}
      {...props}
    />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
  router.replace.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("RecurringPaymentsWorkspace pagination", () => {
  it("shows no pager when every schedule fits on the first page", () => {
    renderWorkspace({ total: 10, listState: { page: 1, pageSize: 25, status: null } });

    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("keeps the pager on a saved page past the end, its back arrow landing on the first page", async () => {
    window.history.replaceState(null, "", "/dashboard/payments/recurring?page=3&status=active");
    renderWorkspace({ total: 10, listState: { page: 3, pageSize: 25, status: "active" } });

    expect(screen.getByText("Page 3 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));

    expect(router.replace).toHaveBeenCalledWith("/dashboard/payments/recurring?status=active", {
      scroll: false,
    });
  });

  it("sends the back arrow past the end to the last page there is", async () => {
    window.history.replaceState(null, "", "/dashboard/payments/recurring?page=7");
    renderWorkspace({ total: 60, listState: { page: 7, pageSize: 25, status: null } });

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));

    expect(router.replace).toHaveBeenCalledWith("/dashboard/payments/recurring?page=3", {
      scroll: false,
    });
  });

  it("counts the rows a page in range shows", () => {
    renderWorkspace({ total: 60, listState: { page: 2, pageSize: 25, status: null } });

    expect(screen.getByText("26-50 of 60 schedules")).toBeTruthy();
  });
});
