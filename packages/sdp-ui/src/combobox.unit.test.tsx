// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "./combobox";
import { EnglishUiI18nProvider } from "./testing/english-ui-i18n";

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
    <EnglishUiI18nProvider>
      <Combobox
        label="Wallet"
        value={null}
        onChange={onChange}
        onEnterSelect={onEnterSelect}
        options={options}
        searchPlaceholder="Search wallets"
      />
    </EnglishUiI18nProvider>
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

describe("Combobox closed trigger", () => {
  it.each([
    {
      labels: "repeated",
      choices: [
        { value: "wallet-a", label: "SDP wallet", description: "Abc1…wxyz" },
        { value: "wallet-b", label: "SDP wallet", description: "Def2…stuv" },
      ],
      value: "wallet-b",
      shown: ["SDP wallet", "Def2…stuv"],
      hidden: "Abc1…wxyz",
    },
    {
      labels: "unique",
      choices: [
        { value: "treasury", label: "Treasury", description: "Ghi3…qrst" },
        { value: "payroll", label: "Payroll", description: "Jkl4…mnop" },
      ],
      value: "payroll",
      shown: ["Payroll"],
      hidden: "Jkl4…mnop",
    },
  ])("names the choice with $labels labels", ({ choices, value, shown, hidden }) => {
    render(
      <EnglishUiI18nProvider>
        <Combobox label="Wallet" value={value} onChange={vi.fn()} options={choices} />
      </EnglishUiI18nProvider>
    );
    const triggerText = screen.getByRole("button", { name: "Wallet" }).textContent;
    for (const text of shown) expect(triggerText).toContain(text);
    expect(triggerText).not.toContain(hidden);
  });
});
