// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { PaymentsDemoState } from "@/lib/payments-demo/payments-demo-context";
import { PaymentsDemoToggle } from "./payments-demo-toggle";

const workspace = vi.hoisted(() => ({
  selectedProjectId: "proj_sandbox" as string | null,
  sdpEnvironment: "sandbox" as "sandbox" | "production",
}));
const setPaymentsDemoAction = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
}));
vi.mock("@/lib/payments-demo/demo-mode-action", () => ({ setPaymentsDemoAction }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const reload = vi.fn();

function renderToggle(state: PaymentsDemoState) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PaymentsDemoToggle {...state} />
    </I18nProvider>
  );
}

beforeEach(() => {
  workspace.selectedProjectId = "proj_sandbox";
  workspace.sdpEnvironment = "sandbox";
  setPaymentsDemoAction.mockResolvedValue(true);
  vi.stubGlobal("location", { ...window.location, reload });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PaymentsDemoToggle", () => {
  it("turns demo mode on for the selected project and redraws the page without a reload", async () => {
    renderToggle({ demoProjectId: null, cookieProjectId: "proj_sandbox" });
    const toggle = screen.getByRole("switch", { name: "Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(toggle);

    expect(setPaymentsDemoAction).toHaveBeenCalledWith(true, "proj_sandbox");
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows on for the project the demo names and turns it off", async () => {
    renderToggle({ demoProjectId: "proj_sandbox", cookieProjectId: "proj_sandbox" });
    const toggle = screen.getByRole("switch", { name: "Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(screen.getByText("Demo"));

    expect(setPaymentsDemoAction).toHaveBeenCalledWith(false, "proj_sandbox");
  });

  it("stays reachable when the project list didn't load", () => {
    workspace.selectedProjectId = null;
    renderToggle({ demoProjectId: "proj_sandbox", cookieProjectId: "proj_sandbox" });

    expect(screen.getByRole("switch", { name: "Demo" }).getAttribute("aria-checked")).toBe("true");
  });

  it("can't be turned on on a production project, but can be turned off", () => {
    workspace.selectedProjectId = "proj_production";
    workspace.sdpEnvironment = "production";
    const { rerender } = renderToggle({ demoProjectId: null, cookieProjectId: null });
    expect((screen.getByRole("switch", { name: "Demo" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PaymentsDemoToggle demoProjectId="proj_production" cookieProjectId={null} />
      </I18nProvider>
    );
    expect((screen.getByRole("switch", { name: "Demo" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("goes back when the switch doesn't take", async () => {
    setPaymentsDemoAction.mockResolvedValue(false);
    renderToggle({ demoProjectId: null, cookieProjectId: "proj_sandbox" });
    const toggle = screen.getByRole("switch", { name: "Demo" });

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
