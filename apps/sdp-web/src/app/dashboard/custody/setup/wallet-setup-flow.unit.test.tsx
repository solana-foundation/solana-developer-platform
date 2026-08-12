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

type FlowProps = Parameters<typeof WalletSetupFlow>[0];

function renderFlowWith(props: Partial<FlowProps> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletSetupFlow
        connectedProviders={props.connectedProviders ?? ["privy"]}
        enabledProviders={props.enabledProviders ?? ["privy", "fireblocks"]}
        initialProvider={props.initialProvider ?? null}
      />
    </I18nProvider>
  );
}

function renderFlow(initialProvider: "privy" | null = null): string {
  return renderFlowWith({ initialProvider });
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

  it("shows providers the organization cannot use yet instead of hiding them", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    for (const label of [
      "Privy",
      "Fireblocks",
      "Turnkey",
      "Anchorage",
      "IBM Digital Asset Haven",
    ]) {
      expect(markup).toContain(label);
    }
    // Each of these ships a working adapter, so none of them may be presented
    // as something that has not arrived yet.
    expect(markup).not.toContain("Coming later");
  });

  it("groups the catalog by what the provider is for", () => {
    // Privy is entitled (API) and Fireblocks offers request access (Institutional).
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: ["privy"] });

    expect(markup).toMatch(/<h3[^>]*>API<\/h3>/);
    expect(markup).toMatch(/<h3[^>]*>Institutional<\/h3>/);
    expect(markup).toContain(
      "Wallet infrastructure for API-driven product, operations, and automated flows."
    );
  });

  it("keeps both categories on the page even when none is granted yet", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    expect(markup).toMatch(/<h3[^>]*>API<\/h3>/);
    expect(markup).toMatch(/<h3[^>]*>Institutional<\/h3>/);
  });

  it("routes a gated provider to request access rather than a dead card", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    expect(markup).toContain("https://solanafoundation.typeform.com/to/wShiq9SN");
    expect(markup).toContain("Request access");
    expect(markup).toMatch(/rel="noreferrer noopener"/);
  });

  it("does not offer request access once the gated provider is connected", () => {
    const intakeLinks = (markup: string) =>
      (markup.match(/https:\/\/solanafoundation\.typeform\.com\/to\/wShiq9SN/g) ?? []).length;

    const gated = renderFlowWith({ connectedProviders: [], enabledProviders: [] });
    const connected = renderFlowWith({
      connectedProviders: ["fireblocks"],
      enabledProviders: [],
    });

    // Connecting Fireblocks retires its own intake route and nobody else's:
    // every provider still to be granted keeps the way to ask for it.
    expect(intakeLinks(connected)).toBe(intakeLinks(gated) - 1);
    expect(connected).toContain("Active");
  });

  it("keeps unusable providers out of the selectable set", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: ["privy"] });

    // Privy is the only entitled provider, so it is the only pressable card.
    expect(markup.match(/aria-pressed=/g)).toHaveLength(1);
    expect(markup).toContain('data-provider-selectable="false"');
  });

  it("gives every provider a card now that none of them is a dead end", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: ["privy"] });

    // Nine cards: Privy is ready to connect and the other eight can be asked
    // for. The local signer is a deployment mode, so it is not one of them.
    expect(markup.match(/data-provider-selection-card="true"/g)).toHaveLength(9);
    expect(markup).not.toContain("Local Signer");
    expect(markup).not.toContain("data-provider-coming-later");
    expect(markup).toContain("Turnkey");
  });

  it("explains why nothing can be selected instead of emptying the page", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    expect(markup).toContain(
      "Wallet creation is available after a custody provider is enabled for this organization."
    );
    expect(markup).toContain("Privy");
    expect(markup).not.toContain("No wallet providers enabled");
  });
});
