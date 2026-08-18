// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnButtonBuilder } from "./earn-button-builder";
import { EARN_PROGRAM_STORAGE_KEY, readAcceptedEarnButtons } from "./earn-program-model";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderBuilder(strategyId?: string) {
  return renderWithEnglish(
    <EarnButtonBuilder earnHref="/demo/markets/earn" strategyId={strategyId} />
  );
}

function previewFigure(label: string): HTMLElement {
  const figure = screen.getByText(label).closest("figure");
  if (!figure) throw new Error(`Could not find the ${label} figure`);
  return figure;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("EarnButtonBuilder", () => {
  it("updates both previews, copies the exact handoff link, and accepts the button", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    renderBuilder("ethena-pyusd-prime");

    const iosPreview = previewFigure("iOS preview");
    const webPreview = previewFigure("Web browser preview");
    const inkRadio = screen.getByRole("radio", { name: /^Ink/ }) as HTMLInputElement;
    const accentRadio = screen.getByRole("radio", { name: /^Accent/ }) as HTMLInputElement;
    expect(inkRadio.checked).toBe(true);
    expect(accentRadio.checked).toBe(false);

    await user.click(accentRadio);

    expect(inkRadio.checked).toBe(false);
    expect(accentRadio.checked).toBe(true);
    for (const preview of [iosPreview, webPreview]) {
      const buttonPreview = within(preview).getByText("Deposit & earn");
      expect(buttonPreview.className).toContain("bg-[#14F195]");
    }

    const integrationLink =
      "https://developers.solana.com/earn/buttons/ethena-pyusd-prime?appearance=accent";
    expect(screen.getByText(integrationLink)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalledWith(integrationLink);
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Integration link copied.");

    await user.click(screen.getByRole("button", { name: "Accept and create button" }));

    const stored = readAcceptedEarnButtons(window.localStorage.getItem(EARN_PROGRAM_STORAGE_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        id: "earn-button-ethena-pyusd-prime-1",
        sequence: 1,
        strategyId: "ethena-pyusd-prime",
        style: "accent",
      })
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Earn button created.");
    expect(mocks.push).toHaveBeenCalledWith("/demo/markets/earn");
  });

  it("offers a recovery route when no valid strategy was supplied", () => {
    renderBuilder();

    expect(screen.getByText("Choose a strategy first")).toBeTruthy();
    expect(
      screen.getByText("Return to Earn Program and select the strategy this button should fund.")
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Return to Earn Program" }).getAttribute("href")).toBe(
      "/demo/markets/earn?create=1"
    );
    expect(screen.queryByText("iOS preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept and create button" })).toBeNull();
  });
});
