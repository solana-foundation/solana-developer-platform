// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { AccountActions, type PickableOrganization } from "./mainnet-access-account-actions";

const ACME: PickableOrganization = { id: "org_test_acme", name: "Acme" };
const GLOBEX: PickableOrganization = { id: "org_test_globex", name: "Globex" };

function renderActions(isSwitching = false, organizations = [ACME, GLOBEX]) {
  const onSwitch = vi.fn<(organizationId: string) => void>();
  const onSignOut = vi.fn<() => void>();
  render(
    <AccountActions
      activeOrganization={ACME}
      organizations={organizations}
      isSwitching={isSwitching}
      onSwitch={onSwitch}
      onSignOut={onSignOut}
    />,
    { wrapper: EnglishI18n }
  );
  return { onSwitch, onSignOut };
}

afterEach(() => {
  cleanup();
});

describe("AccountActions", () => {
  it("offers the other organizations under the active one's name, and signs out", async () => {
    const { onSwitch, onSignOut } = renderActions();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Acme" }));
    expect(screen.queryByRole("menuitem", { name: "Acme" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Globex" }));
    expect(onSwitch).toHaveBeenCalledWith(GLOBEX.id);

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("holds the picker and Sign out while a switch runs", () => {
    renderActions(true);

    expect(screen.getByRole("button", { name: "Acme" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows no picker when there is no other organization", () => {
    renderActions(false, [ACME]);

    expect(screen.queryByRole("button", { name: "Acme" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
