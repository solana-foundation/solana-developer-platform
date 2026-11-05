// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { dashboardDataResponse, readsOf, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { renderBesideReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { OrganizationAlertEmailsSwitch } from "./organization-alert-emails-switch";
import { organizationQueryKeys } from "./organization-query-key";
import * as organizationSettings from "./organization-settings";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SETTINGS_URL = `/dashboard/${SANDBOX_PROJECT.id}/settings`;

const mocks = {
  save: vi.spyOn(organizationSettings, "saveOrganizationAlertEmails"),
  toast: {
    success: vi.spyOn(toast, "success"),
    error: vi.spyOn(toast, "error"),
  },
};

function renderSwitch(initialEnabled: boolean) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OrganizationAlertEmailsSwitch organizationId="org_sdp" initialEnabled={initialEnabled} />
    </I18nProvider>
  );
  return screen.getByRole("switch", { name: "Send alert emails" });
}

beforeEach(() => {
  resetDashboardNavigation();
  window.history.replaceState(null, "", SETTINGS_URL);
  mocks.save.mockReset();
  mocks.toast.success.mockClear();
  mocks.toast.error.mockClear();
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("OrganizationAlertEmailsSwitch", () => {
  it("turns alert emails off, says that admins are told, and re-reads the organization", async () => {
    mocks.save.mockResolvedValue({ ok: true, value: false });
    const currentOrganization = organizationQueryKeys.current({
      projectId: SANDBOX_PROJECT.id,
      mode: "live",
    });
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, {}));
    const user = userEvent.setup();
    renderBesideReads(
      <OrganizationAlertEmailsSwitch organizationId="org_sdp" initialEnabled={true} />,
      [currentOrganization]
    );
    const toggle = screen.getByRole("switch", { name: "Send alert emails" });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    screen.getByText(/Turning them off is itself emailed to admins/);

    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(mocks.save).toHaveBeenCalledWith("org_sdp", false, expect.any(String));
    expect(mocks.toast.success).toHaveBeenCalledWith("Alert emails turned off");
    screen.getByText("No alert emails are sent to admins.");
    await waitFor(() =>
      expect(readsOf(fetchMock, dashboardRequestUrl(currentOrganization))).toBe(2)
    );
  });

  it("keeps the stored value after a refusal and retries it with the same key", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, error: "forbidden" });
    mocks.save.mockResolvedValueOnce({ ok: true, value: true });
    const user = userEvent.setup();
    const toggle = renderSwitch(false);

    await user.click(toggle);
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledOnce());
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    const [first, second] = mocks.save.mock.calls;
    expect([first[1], second[1]]).toEqual([true, true]);
    expect(second[2]).toBe(first[2]);
  });

  it("uses a new key for each saved change", async () => {
    mocks.save.mockResolvedValueOnce({ ok: true, value: false });
    mocks.save.mockResolvedValueOnce({ ok: true, value: true });
    const user = userEvent.setup();
    const toggle = renderSwitch(true);

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    const [first, second] = mocks.save.mock.calls;
    expect(second[2]).not.toBe(first[2]);
  });
});
