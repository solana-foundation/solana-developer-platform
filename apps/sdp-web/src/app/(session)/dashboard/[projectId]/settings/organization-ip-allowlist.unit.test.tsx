// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { OrganizationIpAllowlist } from "./organization-ip-allowlist";
import * as organizationSettings from "./organization-settings";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function renderAllowlist(initialAllowedIps: string[]) {
  render(
    <OrganizationIpAllowlist organizationId="org_sdp" initialAllowedIps={initialAllowedIps} />,
    {
      wrapper: EnglishI18n,
    }
  );
  const field = screen.getByRole("textbox", { name: "Allowed IP addresses" });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("The allowlist field is an input");
  }
  return field;
}

function shownTags(): (string | null)[] {
  return screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((button) => button.getAttribute("aria-label"));
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save allowlist" });
}

const SECURITY_TAB_URL = `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=security`;

beforeEach(() => {
  resetDashboardNavigation();
  window.history.replaceState(null, "", SECURITY_TAB_URL);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreWindowLocation();
});

describe("OrganizationIpAllowlist", () => {
  it("turns a typed range into a tag in the form the API stores", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.type(field, "198.51.100.7/24{Enter}");

    expect(shownTags()).toEqual(["Remove 198.51.100.0/24"]);
    expect(field).toHaveProperty("value", "");
  });

  it("holds Save while an invalid tag is in the list", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist(["203.0.113.10"]);

    await user.type(field, "not-an-ip{Enter}");

    expect(screen.getByText("not a valid IP address or CIDR range")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/^Remove the entries marked in red/);
    expect(saveButton()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Remove not-an-ip" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton()).toHaveProperty("disabled", false);
  });

  it("saves the tags and shows the list as the API returned it", async () => {
    const save = vi
      .spyOn(organizationSettings, "saveOrganizationIpAllowlist")
      .mockResolvedValue({ ok: true, value: ["2001:db8::1", "198.51.100.0/24"] });
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.type(field, "198.51.100.7/24 2001:DB8::1{Enter}");
    await user.click(saveButton());

    await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
    expect(save).toHaveBeenCalledWith(
      "org_sdp",
      "198.51.100.0/24\n2001:db8::1",
      expect.any(String)
    );
    expect(shownTags()).toEqual(["Remove 2001:db8::1", "Remove 198.51.100.0/24"]);
    expect(dashboardRouter.replace).toHaveBeenCalledWith(SECURITY_TAB_URL, { scroll: false });
  });

  it("keeps the tags and the page after a refused save", async () => {
    vi.spyOn(organizationSettings, "saveOrganizationIpAllowlist").mockResolvedValue({
      ok: false,
      error: "upstream unavailable",
    });
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.type(field, "203.0.113.10{Enter}");
    await user.click(saveButton());

    await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
    expect(shownTags()).toEqual(["Remove 203.0.113.10"]);
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("splits pasted lines into one tag each", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.click(field);
    await user.paste("203.0.113.10\n198.51.100.0/24");

    expect(shownTags()).toEqual(["Remove 203.0.113.10", "Remove 198.51.100.0/24"]);
    expect(field).toHaveProperty("value", "");
  });

  it("pastes over the selected text instead of beside it", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.type(field, "notanip");
    field.setSelectionRange(0, 7);
    await user.paste("203.0.113.10");

    expect(shownTags()).toEqual(["Remove 203.0.113.10"]);
  });

  it("removes the last tag on Backspace in an empty field", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist(["198.51.100.0/24", "203.0.113.10"]);

    await user.type(field, "{Backspace}");

    expect(shownTags()).toEqual(["Remove 198.51.100.0/24"]);
  });
});
