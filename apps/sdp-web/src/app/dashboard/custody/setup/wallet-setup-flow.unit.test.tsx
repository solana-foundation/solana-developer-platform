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
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Next");
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(2);
  });

  it("keeps wallet details in the same shell with back and create actions", () => {
    const markup = renderFlow("privy");

    expect(markup).toContain("Step 2 of 2");
    expect(markup).toContain('id="wallet-details-form"');
    expect(markup).toContain("Wallet details");
    expect(markup).toContain(">Back<");
    expect(markup).toContain("Create wallet");
    expect(markup.match(/data-wallet-setup-actions="true"/g)).toHaveLength(1);
  });
});
