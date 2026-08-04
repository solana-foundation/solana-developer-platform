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
    expect(markup).toContain("sm:grid-cols-[repeat(3,6.5rem)]");
    expect(markup).toContain("grid-cols-3");
  });

  it("hides the developer-only asset-header controls by default", () => {
    // Customers get HEADER_APPEARANCE_DEFAULTS and no way to change them.
    const markup = renderWithProviders(<AppearanceSection />);
    expect(markup).toContain("Color theme");
    expect(markup).not.toContain("Asset header");
    expect(markup.match(/<fieldset/g)).toHaveLength(1);
    expect(markup).not.toMatch(/sm:grid-cols-\[repeat\(2,6\.5rem\)\]/);
  });

  it("puts the asset-header controls in the same row as the theme when enabled", () => {
    const markup = renderWithProviders(<AppearanceSection showAssetHeaderControls />);
    expect(markup).toContain("Color theme");
    expect(markup).toContain("Asset header layout");
    expect(markup).toContain("Asset header mode");
    // Each group is its own named fieldset with its own hint.
    expect(markup.match(/<fieldset/g)).toHaveLength(3);
    expect(markup).toContain("Which side the asset logo sits on.");
    expect(markup).toContain("Default corners the actions");
    // Both two-option groups keep the theme's 6.5rem-per-option track.
    expect(markup.match(/sm:grid-cols-\[repeat\(2,6\.5rem\)\]/g)).toHaveLength(2);
    // Each hint is capped to its control's width, so the sentence cannot decide
    // how wide the group is — that is what forced the groups onto separate rows.
    expect(markup.match(/sm:max-w-\[14rem\]/g)).toHaveLength(2);
    expect(markup).toContain("sm:max-w-[20.5rem]");
  });

  it("gives up rows rather than track width as the card narrows", () => {
    const markup = renderWithProviders(<AppearanceSection showAssetHeaderControls />);
    // Measured against the card, not the viewport: the sidebar collapses, so the
    // same window gives this card very different widths.
    expect(markup).toContain("@container");
    // One row once all three groups fit (~824px), the theme on its own row with
    // the pair below it from ~472px, stacked under that.
    expect(markup).toContain("@min-[480px]:flex-row");
    expect(markup).toContain("@min-[480px]:flex-wrap");
    expect(markup).toContain("@min-[480px]:basis-full @min-[840px]:basis-auto");
    // Flex, not a grid: equal columns would be narrower than the theme's fixed
    // track, which does not shrink — it would overlap its neighbour.
    expect(markup).not.toContain('grid-cols-3"');
  });

  it("marks the developer-only controls with a badge inside their legend", () => {
    const markup = renderWithProviders(<AppearanceSection showAssetHeaderControls />);
    const badges = [...markup.matchAll(/<legend[^>]*>([^<]*)<span[^>]*>(Dev mode)<\/span>/g)].map(
      (match) => match[1]?.trim()
    );
    expect(badges).toEqual(["Asset header layout", "Asset header mode"]);
    // The theme is a real setting and carries no badge.
    expect(markup.match(/Dev mode/g)).toHaveLength(2);
  });

  it("shows a busy placeholder for the asset-header controls too", () => {
    // Same reasoning as the theme: the stored choice is unreadable on the server,
    // so a painted selection would flash for anyone not on the default.
    const markup = renderWithProviders(<AppearanceSection showAssetHeaderControls />);
    expect(markup.match(/aria-busy="true"/g)).toHaveLength(3);
    expect(markup).not.toContain("Mirrored");
    expect(markup).not.toContain("Expanded");
  });

  it("translates the card for other locales", () => {
    const markup = renderWithProviders(<AppearanceSection />, "fr");
    expect(markup).toContain("Apparence");
    expect(markup).toContain("uniquement sur cet appareil");
  });
});
