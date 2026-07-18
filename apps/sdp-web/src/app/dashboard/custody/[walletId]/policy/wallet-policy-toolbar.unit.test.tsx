import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WalletPolicyToolbar } from "./wallet-policy-starting-profile-flow";

function renderToolbar(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletPolicyToolbar stepIndex={2} walletHref="/dashboard/wallets/wallet-1" />
    </I18nProvider>
  );
}

describe("WalletPolicyToolbar", () => {
  it("renders one toolbar with the stepper before the policy actions", () => {
    const markup = renderToolbar();

    expect(markup.match(/data-wallet-policy-toolbar="true"/g)).toHaveLength(1);
    expect(markup.match(/data-wallet-policy-stepper="true"/g)).toHaveLength(1);
    expect(markup.match(/data-wallet-policy-toolbar-actions="true"/g)).toHaveLength(1);
    expect(markup.indexOf('data-wallet-policy-stepper="true"')).toBeLessThan(
      markup.indexOf('data-wallet-policy-toolbar-actions="true"')
    );
  });

  it("preserves the progress copy and both action destinations", () => {
    const markup = renderToolbar();

    expect(markup).toContain("Step 3 of 4");
    expect(markup).toContain('href="/dashboard/wallets/wallet-1/policy/audit"');
    expect(markup).toContain('href="/dashboard/wallets/wallet-1/policy/revisions"');
    expect(markup).toContain("Policy audit");
    expect(markup).toContain("Revision history");
  });
});
