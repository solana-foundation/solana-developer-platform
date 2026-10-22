// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateOrganizationResult } from "@/app/dashboard/create-organization-actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { CreateOrganizationForm } from "./create-organization-form";

const mocks = vi.hoisted(() => ({
  createOrganization: vi.fn<(name: string) => Promise<CreateOrganizationResult>>(),
  setActive: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useClerk: () => ({ setActive: mocks.setActive }) }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/app/dashboard/create-organization-actions", () => ({
  createOrganization: mocks.createOrganization,
}));

function renderForm() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <CreateOrganizationForm />
    </I18nProvider>
  );
}

describe("CreateOrganizationForm", () => {
  beforeEach(() => {
    cleanup();
    resetDashboardNavigation();
    mocks.createOrganization.mockReset();
    mocks.setActive.mockReset();
    mocks.setActive.mockResolvedValue(undefined);
  });

  it("creates the organization under the trimmed name, locked while blank or pending, then makes it active", async () => {
    const user = userEvent.setup();
    const created = Promise.withResolvers<CreateOrganizationResult>();
    mocks.createOrganization.mockReturnValue(created.promise);
    renderForm();
    const nameInput = screen.getByRole("textbox", { name: "Organization name" });

    await user.type(nameInput, "   ");
    expect(screen.getByRole("button", { name: "Create organization" })).toHaveProperty(
      "disabled",
      true
    );
    await user.type(nameInput, "Acme Inc  ");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(mocks.createOrganization).toHaveBeenCalledWith("Acme Inc");
    expect(screen.getByRole("button", { name: "Creating…" })).toHaveProperty("disabled", true);
    expect(mocks.setActive).not.toHaveBeenCalled();

    created.resolve({ ok: true, clerkOrganizationId: "org_created" });

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_created" });
  });

  it("toasts a refusal and leaves the session's organization alone", async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, "error");
    mocks.createOrganization.mockResolvedValue({ ok: false, error: "name refused" });
    renderForm();

    await user.type(screen.getByRole("textbox", { name: "Organization name" }), "Acme Inc");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not create the organization: name refused")
    );
    expect(mocks.setActive).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create organization" })).toHaveProperty(
      "disabled",
      false
    );
  });
});
