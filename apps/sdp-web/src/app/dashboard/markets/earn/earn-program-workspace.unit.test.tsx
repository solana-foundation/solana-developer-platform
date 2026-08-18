// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  createAcceptedEarnButton,
  EARN_PROGRAM_STORAGE_KEY,
  serializeAcceptedEarnButtons,
} from "./earn-program-model";
import { EarnProgramWorkspace } from "./earn-program-workspace";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderWorkspace() {
  return renderWithEnglish(
    <EarnProgramWorkspace builderHref="/demo/markets/earn/button-builder" />
  );
}

function strategyRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`Could not find the Earn strategy row for ${name}`);
  return row;
}

function statText(label: string): string | null | undefined {
  return screen.getByText(label).parentElement?.textContent;
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.push.mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("EarnProgramWorkspace", () => {
  it("starts in strategy selection and routes the selected strategy to the demo builder", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const continueButton = (await screen.findByRole("button", {
      name: "Continue to button design",
    })) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    const ethenaRow = strategyRow("Ethena PYUSD Prime");
    const selectButton = within(ethenaRow).getByRole("button", { name: "Select" });
    expect(selectButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(selectButton);

    expect(within(ethenaRow).getByRole("button", { name: "Selected" })).toBeTruthy();
    expect(continueButton.disabled).toBe(false);

    await user.click(continueButton);

    expect(mocks.push).toHaveBeenCalledWith(
      "/demo/markets/earn/button-builder?strategy=ethena-pyusd-prime"
    );
  });

  it("hydrates an accepted button into the overview KPIs and configured-button table", async () => {
    const accepted = createAcceptedEarnButton({
      strategyId: "ethena-pyusd-prime",
      style: "accent",
    });
    if (!accepted) throw new Error("Expected the Ethena mock Earn button to be valid");
    window.localStorage.setItem(EARN_PROGRAM_STORAGE_KEY, serializeAcceptedEarnButtons([accepted]));

    renderWorkspace();

    const table = await screen.findByRole("table");
    expect(statText("Configured buttons")).toBe("Configured buttons1");
    expect(statText("Total customer deposits")).toBe("Total customer deposits$640,000.00");
    expect(statText("Customer APY range")).toBe("Customer APY range8.60%");

    const strategyName = within(table).getAllByText("Ethena PYUSD Prime")[0];
    const row = strategyName?.closest("tr");
    if (!row) throw new Error("Could not find the accepted Ethena button row");

    expect(row.textContent).toContain("Deposit & earn");
    expect(row.textContent).toContain("Accent");
    expect(row.textContent).toContain("iOS + Web");
    expect(row.textContent).toContain("8.60%");
    expect(row.textContent).toContain("$640,000.00");
    expect(row.textContent).toContain("Active");
  });
});
