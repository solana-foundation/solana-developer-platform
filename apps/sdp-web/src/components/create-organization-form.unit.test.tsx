// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as createOrganizationActions from "@/app/dashboard/create-organization-actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { CreateOrganizationForm } from "./create-organization-form";

const mocks = vi.hoisted(() => {
  const session: { organization: { id: string } | null } = { organization: null };
  return { session, setActive: vi.fn() };
});

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ organization: mocks.session.organization, setActive: mocks.setActive }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

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
    vi.restoreAllMocks();
    mocks.session.organization = null;
    mocks.setActive.mockReset();
    mocks.setActive.mockResolvedValue(undefined);
  });

  it("creates the organization under the trimmed name, locked while blank or pending, then makes it active", async () => {
    const user = userEvent.setup();
    const created = Promise.withResolvers<createOrganizationActions.CreateOrganizationResult>();
    const create = vi
      .spyOn(createOrganizationActions, "createOrganization")
      .mockReturnValue(created.promise);
    renderForm();
    const nameInput = screen.getByRole("textbox", { name: "Organization name" });

    await user.type(nameInput, "   ");
    expect(screen.getByRole("button", { name: "Create organization" })).toHaveProperty(
      "disabled",
      true
    );
    await user.type(nameInput, "Acme Inc  ");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(create).toHaveBeenCalledWith("Acme Inc");
    expect(screen.getByRole("button", { name: "Creating…" })).toHaveProperty("disabled", true);
    expect(mocks.setActive).not.toHaveBeenCalled();

    created.resolve({ ok: true, clerkOrganizationId: "org_created" });

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(mocks.setActive).toHaveBeenCalledWith({ organization: "org_created" });
  });

  it("toasts a refusal and leaves the session's organization alone", async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, "error");
    vi.spyOn(createOrganizationActions, "createOrganization").mockResolvedValue({
      ok: false,
      error: "name refused",
    });
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

  it("clears Clerk's active organization before creating one", async () => {
    const user = userEvent.setup();
    mocks.session.organization = { id: "org_refused" };
    const create = vi
      .spyOn(createOrganizationActions, "createOrganization")
      .mockResolvedValue({ ok: true, clerkOrganizationId: "org_created" });
    renderForm();

    await user.type(screen.getByRole("textbox", { name: "Organization name" }), "Acme Inc");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(mocks.setActive.mock.calls).toEqual([
      [{ organization: null }],
      [{ organization: "org_created" }],
    ]);
    expect(mocks.setActive.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]
    );
  });
});
