import type { CustodyConfigSummary } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OrganizationCustodySettingsSection } from "./organization-custody-settings-section";

function config(overrides: Partial<CustodyConfigSummary> = {}): CustodyConfigSummary {
  return {
    id: "cfg-1",
    organizationId: "org-1",
    projectId: null,
    provider: "privy",
    publicKey: "pubkey-1",
    defaultWalletId: null,
    status: "active",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function render(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

describe("OrganizationCustodySettingsSection", () => {
  it("names each connected custody provider", () => {
    const markup = render(<OrganizationCustodySettingsSection configs={[config()]} />);

    expect(markup).toContain("Privy");
  });

  it("always offers a path to connect another provider", () => {
    // The capability already existed at the wallet setup route; Settings simply
    // never surfaced it, which is what made the onboarding promise read as false.
    const markup = render(<OrganizationCustodySettingsSection configs={[]} />);

    expect(markup).toContain("/dashboard/wallets/setup");
  });

  it("says so plainly when nothing is connected", () => {
    const markup = render(<OrganizationCustodySettingsSection configs={[]} />);

    expect(markup).toContain("No custody provider is connected yet.");
  });

  it("lists only active configs", () => {
    const markup = render(
      <OrganizationCustodySettingsSection
        configs={[config(), config({ id: "cfg-2", provider: "turnkey", status: "inactive" })]}
      />
    );

    expect(markup).toContain("Privy");
    expect(markup).not.toContain("Turnkey");
  });

  it("does not promise a switch it cannot perform", () => {
    // Connecting a second provider adds a config; it does not migrate the wallet
    // onboarding already provisioned on the first one.
    const markup = render(<OrganizationCustodySettingsSection configs={[config()]} />);

    expect(markup).not.toContain("Change provider");
  });
});
