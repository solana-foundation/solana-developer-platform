// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("./organization-access-actions", () => ({
  saveOrganizationAlertEmailsAction: mocks.save,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { OrganizationAlertEmailsSwitch } from "./organization-alert-emails-switch";

function renderSwitch(initialEnabled: boolean) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OrganizationAlertEmailsSwitch initialEnabled={initialEnabled} />
    </I18nProvider>
  );
  return screen.getByRole("switch", { name: "Send alert emails" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("OrganizationAlertEmailsSwitch", () => {
  it("turns alert emails off and says that admins are told", async () => {
    mocks.save.mockResolvedValue({ ok: true, enabled: false });
    const user = userEvent.setup();
    const toggle = renderSwitch(true);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    screen.getByText(/Turning them off is itself emailed to admins/);

    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(mocks.save).toHaveBeenCalledWith(false, expect.any(String));
    expect(mocks.toast.success).toHaveBeenCalledWith("Alert emails turned off");
    screen.getByText("No alert emails are sent to admins.");
  });

  it("keeps the stored value after a refusal and retries it with the same key", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, error: "forbidden" });
    mocks.save.mockResolvedValueOnce({ ok: true, enabled: true });
    const user = userEvent.setup();
    const toggle = renderSwitch(false);

    await user.click(toggle);
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledOnce());
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    const [first, second] = mocks.save.mock.calls;
    expect(first?.[0]).toBe(true);
    expect(second?.[0]).toBe(true);
    expect(second?.[1]).toBe(first?.[1]);
  });

  it("uses a new key for each saved change", async () => {
    mocks.save.mockResolvedValueOnce({ ok: true, enabled: false });
    mocks.save.mockResolvedValueOnce({ ok: true, enabled: true });
    const user = userEvent.setup();
    const toggle = renderSwitch(true);

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    const [first, second] = mocks.save.mock.calls;
    expect(second?.[1]).not.toBe(first?.[1]);
  });
});
