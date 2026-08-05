import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WalletSetupFlow } from "./wallet-setup-flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/app/dashboard/custody/actions", () => ({
  createCustodySetupWalletAction: vi.fn(),
  initializeCustodySetupAction: vi.fn(),
}));

function renderFlow(initialProvider: "privy" | null = null): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletSetupFlow
        connectedProviders={["privy"]}
        enabledProviders={["privy", "fireblocks"]}
        initialProvider={initialProvider}
      />
    </I18nProvider>
  );
}

describe("WalletSetupFlow", () => {
  it("keeps the legacy wallet details for privy while the BYOK flag is off", () => {
    const markup = renderFlow("privy");

    expect(markup).toContain("Wallet details");
    expect(markup).not.toContain("data-privy-byok-form");
  });

  it("sends an uninstalled privy to provider details when BYOK is on", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <WalletSetupFlow
          connectedProviders={[]}
          enabledProviders={["privy"]}
          initialProvider="privy"
          privyByokEnabled
        />
      </I18nProvider>
    );

    expect(markup).toContain("Provider details");
    expect(markup).toContain("data-privy-byok-form");
    expect(markup).toMatch(/type="password"/);
    // The credential form owns its submit; the footer offers no second one.
    expect(markup).not.toContain("Create wallet");
  });

  it("keeps an installed privy on the additional-wallet path even with BYOK on", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <WalletSetupFlow
          connectedProviders={["privy"]}
          enabledProviders={["privy"]}
          initialProvider="privy"
          privyByokEnabled
        />
      </I18nProvider>
    );

    expect(markup).toContain("Wallet details");
    expect(markup).not.toContain("data-privy-byok-form");
  });

  it("uses the shared top progress and bottom action layout for provider selection", () => {
    const markup = renderFlow();

    expect(markup.match(/data-wallet-setup-stepper="true"/g)).toHaveLength(1);
    expect(markup).toContain("Step 1 of 2");
    expect(markup.match(/data-wallet-setup-scroll-region="true"/g)).toHaveLength(1);
    expect(markup.match(/data-wallet-setup-actions="true"/g)).toHaveLength(1);
    expect(markup.indexOf('data-wallet-setup-stepper="true"')).toBeLessThan(
      markup.indexOf('data-wallet-setup-scroll-region="true"')
    );
    expect(markup.indexOf('data-wallet-setup-scroll-region="true"')).toBeLessThan(
      markup.indexOf('data-wallet-setup-actions="true"')
    );
    expect(markup).not.toContain("bg-white/95");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Next");
    expect(markup).toContain('id="wallet-provider-form"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*form="wallet-provider-form"/);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(markup).not.toContain("data-wallet-enter-advance");
  });

  it("keeps wallet details in the same shell with back and create actions", () => {
    const markup = renderFlow("privy");

    expect(markup).toContain("Step 2 of 2");
    expect(markup).toContain('id="wallet-details-form"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*form="wallet-details-form"/);
    expect(markup).toContain("Wallet details");
    expect(markup).toContain(">Back<");
    expect(markup).toContain("Create wallet");
    expect(markup.match(/data-wallet-setup-actions="true"/g)).toHaveLength(1);
  });
});
