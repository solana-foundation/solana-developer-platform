// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { IssuanceSection } from "./issuance-section";
import { MarketsSection } from "./markets-section";
import { PrivacySection } from "./privacy-section";

vi.mock("motion/react", () => ({
  useInView: () => true,
  useReducedMotion: () => false,
}));

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);
const sandbox = { href: "/sign-up", label: "Homepage.nav.createAccount" } as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function inI18n(children: React.ReactNode) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

describe("IssuanceSection", () => {
  it("lays the example asset out as terms and values", () => {
    inI18n(<IssuanceSection t={t} sandbox={sandbox} />);

    const sheet = screen.getByLabelText("An example asset’s configuration");
    const pairs = Array.from(sheet.querySelectorAll("dt")).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(pairs).toContainEqual(["Standard", "Token-2022"]);
    expect(pairs).toContainEqual(["Privacy", "Confidential balances"]);
    expect(pairs[0]).toEqual(["USDxan example asset", "Stablecoin"]);
  });

  it("is the first product row and leads into the sandbox", () => {
    inI18n(<IssuanceSection t={t} sandbox={sandbox} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Issue the asset. Control after launch." })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open issuance in the sandbox" }).getAttribute("href")
    ).toBe("/sign-up");
  });
});

describe("MarketsSection", () => {
  it("describes the chart in words and gives the figures as terms", () => {
    inI18n(<MarketsSection t={t} sandbox={sandbox} />);

    expect(screen.getByRole("img", { name: /curated DeFi rises to about 8%/ })).toBeTruthy();
    expect(screen.getByText("3.5–8%").tagName).toBe("DT");
    expect(screen.getByText("Tokenized treasuries · ~4.5%")).toBeTruthy();
  });
});

describe("PrivacySection", () => {
  it("gives assistive technology the whole list at once", () => {
    inI18n(<PrivacySection t={t} sandbox={sandbox} />);

    expect(
      screen.getByText("What stays private: Payments, Issuance, Markets, Payroll, Balances")
    ).toBeTruthy();
  });

  it("turns the words while on screen, and stops when paused", () => {
    const { container } = inI18n(<PrivacySection t={t} sandbox={sandbox} />);
    const current = () => container.querySelector('[data-current="true"]')?.textContent;

    expect(current()).toBe("Payments");
    act(() => vi.advanceTimersByTime(2600));
    expect(current()).toBe("Issuance");

    fireEvent.click(screen.getByRole("button", { name: "Pause the list of private operations" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(current()).toBe("Issuance");
    expect(
      screen.getByRole("button", { name: "Play the list of private operations" })
    ).toBeTruthy();
  });
});
