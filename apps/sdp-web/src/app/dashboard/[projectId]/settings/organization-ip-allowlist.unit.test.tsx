// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import * as accessActions from "./organization-access-actions";
import { OrganizationIpAllowlist } from "./organization-ip-allowlist";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function renderAllowlist(initialAllowedIps: string[]) {
  render(<OrganizationIpAllowlist initialAllowedIps={initialAllowedIps} />, {
    wrapper: EnglishI18n,
  });
  return screen.getByRole("textbox", { name: "Allowed IP addresses" });
}

function shownTags(): (string | null)[] {
  return screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((button) => button.getAttribute("aria-label"));
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save allowlist" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      .spyOn(accessActions, "saveOrganizationIpAllowlistAction")
      .mockResolvedValue({ ok: true, allowedIps: ["2001:db8::1", "198.51.100.0/24"] });
    const user = userEvent.setup();
    const field = renderAllowlist([]);

    await user.type(field, "198.51.100.7/24 2001:DB8::1{Enter}");
    await user.click(saveButton());

    await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
    expect(save).toHaveBeenCalledWith("198.51.100.0/24\n2001:db8::1", expect.any(String));
    expect(shownTags()).toEqual(["Remove 2001:db8::1", "Remove 198.51.100.0/24"]);
  });

  it("removes the last tag on Backspace in an empty field", async () => {
    const user = userEvent.setup();
    const field = renderAllowlist(["198.51.100.0/24", "203.0.113.10"]);

    await user.type(field, "{Backspace}");

    expect(shownTags()).toEqual(["Remove 198.51.100.0/24"]);
  });
});
