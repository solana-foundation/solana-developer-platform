import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HomeQuickActions } from "./home-quick-actions";

function renderWithProviders(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

describe("HomeQuickActions", () => {
  it("offers the custody and api key entry points when the member may act on them", () => {
    const markup = renderWithProviders(
      <HomeQuickActions capabilities={{ canManageCustody: true, canManageApiKeys: true }} />
    );

    expect(markup).toContain("Create a wallet");
    expect(markup).toContain("Issue an API key");
    expect(markup).toContain("/dashboard/wallets");
    expect(markup).toContain("/dashboard/api-keys");
  });

  it("hides entry points the member would only be 403'd on", () => {
    const markup = renderWithProviders(
      <HomeQuickActions capabilities={{ canManageCustody: false, canManageApiKeys: false }} />
    );

    expect(markup).not.toContain("Create a wallet");
    expect(markup).not.toContain("Issue an API key");
  });

  it("always offers the entry points that need no elevated permission", () => {
    const markup = renderWithProviders(
      <HomeQuickActions capabilities={{ canManageCustody: false, canManageApiKeys: false }} />
    );

    expect(markup).toContain("Send a payment");
    expect(markup).toContain("Set a wallet policy");
  });

  it("leads with an instruction rather than a balance", () => {
    // The point of this surface: a freshly provisioned organization was landing on
    // a $0.00 hero, which reads as broken rather than new.
    const markup = renderWithProviders(
      <HomeQuickActions capabilities={{ canManageCustody: true, canManageApiKeys: true }} />
    );

    expect(markup).toContain("Start here");
    expect(markup).not.toContain("$0.00");
  });
});
