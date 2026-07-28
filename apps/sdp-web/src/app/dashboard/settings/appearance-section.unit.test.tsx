import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/contexts/theme-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AppearanceSection } from "./appearance-section";

function renderWithProviders(children: ReactNode, locale: "en" | "fr" = "en") {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={getMessages(locale)}>
      <ThemeProvider>{children}</ThemeProvider>
    </I18nProvider>
  );
}

describe("AppearanceSection", () => {
  it("renders the appearance card with its device-scoped description", () => {
    const markup = renderWithProviders(<AppearanceSection />);
    expect(markup).toContain("Appearance");
    expect(markup).toContain("this device only");
    expect(markup).toContain("Color theme");
  });

  // Server render == the first client render, when the stored preference is unreadable.
  // Painting a checked radio here would flash the wrong option for system-dark users.
  it("shows a busy placeholder instead of guessing a selection before hydration", () => {
    const markup = renderWithProviders(<AppearanceSection />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("checked");
    expect(markup).not.toContain('type="radio"');
  });

  it("defaults its hint to the system wording before hydration", () => {
    const markup = renderWithProviders(<AppearanceSection />);
    expect(markup).toContain("follows your device appearance settings");
    expect(markup).not.toContain("always uses the light theme");
    expect(markup).not.toContain("always uses the dark theme");
  });

  it("keeps the placeholder geometry identical to the real control", () => {
    // Guards the layout jump the settings skeleton comment already warns about.
    const markup = renderWithProviders(<AppearanceSection />);
    expect(markup).toContain("sm:grid-cols-[repeat(3,7.5rem)]");
    expect(markup).toContain("grid-cols-3");
  });

  it("translates the card for other locales", () => {
    const markup = renderWithProviders(<AppearanceSection />, "fr");
    expect(markup).toContain("Apparence");
    expect(markup).toContain("uniquement sur cet appareil");
  });
});
