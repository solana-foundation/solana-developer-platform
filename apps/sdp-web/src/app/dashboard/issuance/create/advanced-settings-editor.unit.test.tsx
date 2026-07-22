import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AdvancedSettingsEditor } from "./advanced-settings-editor";
import { createInitialCapacities } from "./issuance-draft-wizard.types";

function renderWithI18n(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

const baseProps = {
  category: "stablecoin" as const,
  type: "fiat_backed",
  settings: {},
  onSettingsChange: () => undefined,
  capacities: createInitialCapacities(),
  onCapacitiesChange: () => undefined,
};

describe("AdvancedSettingsEditor", () => {
  it("renders one collapsed list with permanent and ongoing sections (no mode tabs)", () => {
    const markup = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    expect(markup).toContain("Permanent");
    expect(markup).toContain("Ongoing");
    // The Basic/Detailed/Expert tabs are gone.
    expect(markup).not.toContain("Detailed");
    expect(markup).not.toContain("Expert");
  });

  it("keeps setting labels human and hides technical extension names until toggled", () => {
    const markup = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    expect(markup).toContain(">View<");
    // stablecoin locks the pausable extension; its raw name only shows in technical mode.
    expect(markup).not.toContain("pausable");
  });

  it("renders the access-control row only when a change handler is provided", () => {
    const withAccess = renderWithI18n(
      <AdvancedSettingsEditor
        {...baseProps}
        accessControl=""
        onAccessControlChange={() => undefined}
      />
    );
    expect(withAccess).toContain("Access control");
    expect(withAccess).toContain("Allow list");

    const withoutAccess = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    expect(withoutAccess).not.toContain("Access control");
  });

  it("renders off-chain capacities as plain toggles (no not-enforced badge)", () => {
    const markup = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    expect(markup).toContain("Verified holders"); // the kyc capacity label
    expect(markup).not.toContain("Not enforced yet");
  });

  it("reveals a Configure affordance for a configurable capacity when config is allowed", () => {
    const capacities = createInitialCapacities();
    capacities.restrictTradingHours = { enabled: true };
    const markup = renderWithI18n(
      <AdvancedSettingsEditor {...baseProps} capacities={capacities} allowCapacityConfig />
    );
    expect(markup).toContain("Configure");
    expect(markup).toContain("Not configured yet");
  });

  it("keeps capacities declaration-only in the wizard: no per-card config UI", () => {
    const capacities = createInitialCapacities();
    capacities.restrictTradingHours = { enabled: true };
    const markup = renderWithI18n(
      <AdvancedSettingsEditor {...baseProps} capacities={capacities} />
    );
    // No per-card Configure / summary in the wizard...
    expect(markup).not.toContain("Not configured yet");
    // ...the section subtitle explains config happens later on the compliance tab.
    expect(markup).toContain("A starting set for this asset");
  });

  it("offers quick-fill presets, hidden once the on-chain settings are read-only", () => {
    const editable = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    expect(editable).toContain("Start from a scenario");

    const readOnly = renderWithI18n(<AdvancedSettingsEditor {...baseProps} settingsReadOnly />);
    expect(readOnly).not.toContain("Start from a scenario");
  });
});
