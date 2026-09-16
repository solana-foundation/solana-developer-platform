// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { Combobox, type ComboboxOption } from "./combobox";

const options: ComboboxOption[] = [
  { value: "ok", label: "Treasury" },
  {
    value: "off",
    label: "BYOK Test",
    badge: "Restricted",
    badgeVariant: "warning",
    disabled: true,
  },
];

function renderCombobox() {
  const onChange = vi.fn();
  const onEnterSelect = vi.fn();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <Combobox
        label="Wallet"
        value={null}
        onChange={onChange}
        onEnterSelect={onEnterSelect}
        options={options}
        searchPlaceholder="Search wallets"
      />
    </I18nProvider>
  );
  return { onChange, onEnterSelect };
}

afterEach(cleanup);

describe("Combobox disabled options", () => {
  it("shows a disabled option but ignores a click on it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox();
    await user.click(screen.getByRole("button", { name: "Wallet" }));
    const restricted = screen.getByRole("button", { name: /BYOK Test/ });
    expect(restricted.getAttribute("aria-disabled")).toBe("true");
    expect(restricted.textContent).toContain("Restricted");
    fireEvent.click(restricted);
    expect(onChange).not.toHaveBeenCalled();
    // The list stays open: nothing was picked.
    expect(screen.getByRole("button", { name: /BYOK Test/ })).toBeTruthy();
  });

  it("neither highlights nor auto-selects a lone disabled match on Enter", async () => {
    const user = userEvent.setup();
    const { onChange, onEnterSelect } = renderCombobox();
    await user.click(screen.getByRole("button", { name: "Wallet" }));
    const search = screen.getByPlaceholderText("Search wallets");
    await user.type(search, "BYOK");
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(onEnterSelect).not.toHaveBeenCalled();
  });

  it("ignores Enter on a disabled option reached with the arrow keys", async () => {
    const user = userEvent.setup();
    const { onChange, onEnterSelect } = renderCombobox();
    await user.click(screen.getByRole("button", { name: "Wallet" }));
    const search = screen.getByPlaceholderText("Search wallets");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(search.getAttribute("aria-activedescendant")).toMatch(/-option-1$/);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(onEnterSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /BYOK Test/ })).toBeTruthy();
  });

  it("still selects an enabled option by click and by Enter", async () => {
    const user = userEvent.setup();
    const { onChange, onEnterSelect } = renderCombobox();
    await user.click(screen.getByRole("button", { name: "Wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    expect(onChange).toHaveBeenCalledWith("ok");
    expect(screen.queryByRole("button", { name: /Treasury/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Wallet" }));
    await user.type(screen.getByPlaceholderText("Search wallets"), "Trea");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("ok");
    expect(onEnterSelect).toHaveBeenCalledWith("ok");
  });
});
