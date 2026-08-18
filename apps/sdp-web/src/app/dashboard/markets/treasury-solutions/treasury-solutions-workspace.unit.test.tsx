// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TreasurySolutionsWorkspace } from "./treasury-solutions-workspace";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

function renderWorkspace() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TreasurySolutionsWorkspace />
    </I18nProvider>
  );
}

function rowForStrategy(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`Could not find the strategy row for ${name}`);
  return row;
}

function walletUsdcAmount(): string | null | undefined {
  return screen.getByText("USDC", { selector: "dt" }).parentElement?.querySelector("dd")
    ?.textContent;
}

afterEach(cleanup);

describe("TreasurySolutionsWorkspace", () => {
  it("moves mock USDC between the wallet and the selected strategy", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(walletUsdcAmount()).toBe("4,250,000.00");
    expect(within(rowForStrategy("Ethena PYUSD Prime")).getByText("$650,000.00")).toBeTruthy();

    const usdgWithdraw = within(rowForStrategy("Steakhouse USDG High Yield")).getByRole("button", {
      name: "Withdraw",
    }) as HTMLButtonElement;
    expect(usdgWithdraw.disabled).toBe(true);

    await user.click(
      within(rowForStrategy("Ethena PYUSD Prime")).getByRole("button", {
        name: "Deposit",
      })
    );

    const depositDialog = await screen.findByRole("dialog", {
      name: "Deposit into Ethena PYUSD Prime",
    });
    expect(within(depositDialog).getByText("Atomic asset conversion")).toBeTruthy();
    expect(
      within(depositDialog).getByText(
        "This deposit includes an atomic swap from USDC into PYUSD before funds enter the strategy."
      )
    ).toBeTruthy();

    await user.type(within(depositDialog).getByLabelText(/Amount/), "100");
    await user.click(within(depositDialog).getByRole("button", { name: "Confirm deposit" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(walletUsdcAmount()).toBe("4,249,900.00");
    expect(within(rowForStrategy("Ethena PYUSD Prime")).getByText("$650,100.00")).toBeTruthy();

    await user.click(
      within(rowForStrategy("Ethena PYUSD Prime")).getByRole("button", {
        name: "Withdraw",
      })
    );

    const withdrawDialog = await screen.findByRole("dialog", {
      name: "Withdraw from Ethena PYUSD Prime",
    });
    await user.type(within(withdrawDialog).getByLabelText(/Amount/), "50");
    await user.click(
      within(withdrawDialog).getByRole("button", {
        name: "Confirm withdrawal",
      })
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(walletUsdcAmount()).toBe("4,249,950.00");
    expect(within(rowForStrategy("Ethena PYUSD Prime")).getByText("$650,050.00")).toBeTruthy();
  });

  it("shows validation when a deposit exceeds the wallet USDC balance", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(
      within(rowForStrategy("Ethena PYUSD Prime")).getByRole("button", {
        name: "Deposit",
      })
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Deposit into Ethena PYUSD Prime",
    });
    const amountInput = within(dialog).getByLabelText(/Amount/);
    await user.type(amountInput, "4250000.000001");
    await user.click(within(dialog).getByRole("button", { name: "Confirm deposit" }));

    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "This deposit is greater than the USDC available in your wallet."
    );
    expect(amountInput.getAttribute("aria-invalid")).toBe("true");
    expect(walletUsdcAmount()).toBe("4,250,000.00");
  });
});
