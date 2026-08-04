import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WalletPolicyToolbar } from "./wallet-policy-toolbar";

function renderToolbar(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletPolicyToolbar walletHref="/dashboard/wallets/wallet-1" walletId="wallet-1" />
    </I18nProvider>
  );
}

describe("WalletPolicyToolbar", () => {
  it("preserves the audit destination and the revision history trigger", () => {
    const markup = renderToolbar();

    expect(markup).toContain('href="/dashboard/wallets/wallet-1/policy/audit"');
    expect(markup).toContain("Policy audit");
    expect(markup).toContain("Revision history");
  });
});
