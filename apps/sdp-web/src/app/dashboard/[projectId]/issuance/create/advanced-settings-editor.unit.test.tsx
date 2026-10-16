import { listSettingsForType } from "@sdp/issuance/capabilities";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AdvancedSettingsEditor } from "./advanced-settings-editor";
import { TokenControlRow } from "./token-control-row";
import {
  findControlConflict,
  groupTokenControls,
  settlementBlockedMessageKey,
  toggleTokenControl,
} from "./token-controls-model";

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
  mode: "editable" as const,
};
describe("token controls editor", () => {
  it("locks a required control toggle without disabling its draft parameters", () => {
    const fee = listSettingsForType("generic", "generic").find(
      (entry) => entry.key === "transferFee"
    );
    if (!fee) throw new Error("Missing transfer-fee capability");
    const markup = renderWithI18n(
      <TokenControlRow
        entry={{ ...fee, availability: "locked" }}
        selection={{ params: { basisPoints: "50", maxFee: "100" } }}
        variant="advanced"
        mode="editable"
        showErrors={false}
        onToggle={() => undefined}
        onParam={() => undefined}
      />
    );
    const inputs = markup.match(/<input[^>]*>/g) ?? [];
    expect(inputs.find((input) => input.includes('type="checkbox"'))).toContain('disabled=""');
    expect(inputs.find((input) => input.includes('value="50"'))).not.toContain('disabled=""');
  });
  it("keeps advanced controls collapsed without repeated descriptions", () => {
    const markup = renderWithI18n(
      <AdvancedSettingsEditor {...baseProps} category="generic" type="generic" />
    );
    const advanced = markup.match(/<details[\s\S]*?<\/details>/)?.[0];
    expect(advanced).toContain("Advanced controls");
    expect(advanced).not.toContain('open=""');
    expect(advanced).not.toContain("mt-0.5 block text-xs text-tertiary");
    expect(advanced).toContain('type="checkbox"');
  });
  it("keeps required stablecoin controls in a compact list, without retired modes", () => {
    const markup = renderWithI18n(<AdvancedSettingsEditor {...baseProps} />);
    for (const label of ["Emergency pause capability", "Freeze balances", "Recovery authority"])
      expect(markup).toContain(label);
    for (const label of [
      "Ongoing",
      "Advanced settings",
      "Recommended",
      "Common add-ons",
      "Verified holders",
    ])
      expect(markup).not.toContain(label);
  });
  it("renders the recipient selector only when supplied", () => {
    const markup = renderWithI18n(
      <AdvancedSettingsEditor
        {...baseProps}
        accessControl="disabled"
        onAccessControlChange={() => undefined}
      />
    );
    expect(markup).toContain("Any recipient");
    expect(markup).toContain('role="combobox"');
    expect(renderWithI18n(<AdvancedSettingsEditor {...baseProps} />)).not.toContain(
      'role="combobox"'
    );
  });
  it("hides unselected controls after deployment and keeps selected parameters disabled", () => {
    const markup = renderWithI18n(
      <AdvancedSettingsEditor
        {...baseProps}
        category="generic"
        type="generic"
        mode="readonly"
        settings={{ transferFee: { params: { basisPoints: "50", maxFee: "100" } } }}
      />
    );
    expect(markup).toContain("Transfer fee");
    expect(markup).toContain('value="50"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("Interest-bearing");
  });
  it("initializes setting parameters and never toggles a required setting", () => {
    const entries = listSettingsForType("generic", "generic");
    const fee = entries.find((entry) => entry.key === "transferFee");
    expect(fee).toBeDefined();
    if (!fee) throw new Error("Missing transfer-fee capability");
    const enabled = toggleTokenControl({}, fee, true);
    expect(enabled.transferFee).toHaveProperty("params");
    expect(toggleTokenControl(enabled, fee, false)).not.toHaveProperty("transferFee");
    const locked = listSettingsForType("stablecoin", "fiat_backed").find(
      (entry) => entry.availability === "locked"
    );
    if (!locked) throw new Error("Missing required stablecoin capability");
    const settings = {};
    expect(toggleTokenControl(settings, locked, false)).toBe(settings);
  });
  it("preserves conflict restrictions and groups only deployed settings in read-only mode", () => {
    const entries = listSettingsForType("generic", "generic");
    const fee = entries.find((entry) => entry.key === "transferFee");
    if (!fee) throw new Error("Missing transfer-fee capability");
    expect(findControlConflict(fee, entries, { nonTransferable: {} })?.key).toBe("nonTransferable");
    expect(findControlConflict(fee, entries, { transferFee: {} })).toBeUndefined();
    const groups = groupTokenControls(entries, { transferFee: {} }, "readonly");
    expect(groups.advanced.map((entry) => entry.key)).toEqual(["transferFee"]);
  });

  // The choice is permanent at mint time, so the warning has to be readable while
  // the box is still unticked. A warning that only appeared once selected would
  // arrive after the decision it exists to inform.
  describe("DvP settlement warning", () => {
    const securityProps = { ...baseProps, category: "tokenized_security" as const, type: "equity" };

    it("warns on scaledUiAmount before it is selected, and says why", () => {
      const markup = renderWithI18n(<AdvancedSettingsEditor {...securityProps} />);

      expect(markup).toContain("Scaled display amount");
      expect(markup).toContain("No atomic settlement");
      // The amount-mutating reason, not the escrow one.
      expect(markup).toContain("the amount credited can differ from the amount sent");
      expect(markup).not.toContain("could never leave escrow");
    });

    it("gives nonTransferable the escrow reason, not the amount one", () => {
      // Securities mark nonTransferable unsupported, so use the generic category
      // where every setting is offered.
      const markup = renderWithI18n(
        <AdvancedSettingsEditor {...baseProps} category="generic" type="generic" />
      );

      expect(markup).toContain("Non-transferable");
      expect(markup).toContain("tokens could never leave escrow");
    });

    // The draft form renders its controls from booleans, not capability
    // entries, so it names these two keys directly. If the deny list stops
    // covering them the form silently loses its warning, which no render
    // assertion here would catch.
    it("covers the two extensions the draft form offers", () => {
      expect(settlementBlockedMessageKey("interestBearing")).toBe(
        "DashboardIssuance.config.settlementBlockedAmount"
      );
      expect(settlementBlockedMessageKey("transferFee")).toBe(
        "DashboardIssuance.config.settlementBlockedAmount"
      );
      expect(settlementBlockedMessageKey("nonTransferable")).toBe(
        "DashboardIssuance.config.settlementBlockedEscrow"
      );
      expect(settlementBlockedMessageKey("permanentDelegate")).toBeNull();
    });

    it("leaves settings the program accepts unmarked", () => {
      const markup = renderWithI18n(
        <AdvancedSettingsEditor {...baseProps} category="generic" type="generic" />
      );

      // permanentDelegate and transferHook are explicitly allowed by the program;
      // if the warning leaked onto every row it would say nothing.
      expect(markup).toContain("Custom transfer rules");
      const warnings = markup.split("No atomic settlement").length - 1;
      // transferFee, interestBearing, scaledUiAmount, nonTransferable — four.
      expect(warnings).toBe(4);
    });
  });
});
