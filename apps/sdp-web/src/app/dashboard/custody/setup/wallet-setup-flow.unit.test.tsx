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
    expect(markup).toContain("Coming later");
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

  it("drops a category heading when nothing in it is on offer", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    expect(markup).not.toMatch(/<h3[^>]*>API<\/h3>/);
    expect(markup).toMatch(/<h3[^>]*>Institutional<\/h3>/);
  });

  it("routes a gated provider to request access rather than a dead card", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: [] });

    expect(markup).toContain("https://solanafoundation.typeform.com/to/wShiq9SN");
    expect(markup).toContain("Request access");
    expect(markup).toMatch(/rel="noreferrer noopener"/);
  });

  it("does not offer request access once the gated provider is connected", () => {
    const markup = renderFlowWith({
      connectedProviders: ["fireblocks"],
      enabledProviders: [],
    });

    expect(markup).not.toContain("https://solanafoundation.typeform.com/to/wShiq9SN");
    expect(markup).toContain("Active");
  });

  it("keeps unusable providers out of the selectable set", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: ["privy"] });

    // Privy is the only entitled provider, so it is the only pressable card.
    expect(markup.match(/aria-pressed=/g)).toHaveLength(1);
    expect(markup).toContain('data-provider-selectable="false"');
  });

  it("keeps providers with no action out of the card list so the usable ones lead", () => {
    const markup = renderFlowWith({ connectedProviders: [], enabledProviders: ["privy"] });

    // Only Privy (available) and Fireblocks (request access) earn a card; the
    // remaining eight are named in the compact group.
    expect(markup.match(/data-provider-selection-card="true"/g)).toHaveLength(2);
    expect(markup).toContain('data-provider-coming-later="true"');
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
