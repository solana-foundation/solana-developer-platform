import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OrganizationOnboardingFlow } from "./organization-onboarding-flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("./actions", () => ({
  completeOrganizationOnboardingAction: vi.fn(),
  saveOnboardingRpcAction: vi.fn(),
}));

function renderFlow(currentStep: "rpc" | "custody" = "rpc") {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OrganizationOnboardingFlow
        organizationId="org_test"
        currentStep={currentStep}
        initialRpcProvider={currentStep === "custody" ? "helius" : null}
        rpcProviders={["default", "alchemy", "helius", "quicknode", "triton", "validationcloud"]}
        custodyProviders={["privy", "coinbase_cdp", "para", "turnkey"]}
      />
    </I18nProvider>
  );
}

describe("OrganizationOnboardingFlow", () => {
  it("starts with every vendor RPC card and omits the SDP default", () => {
    const markup = renderFlow();

    expect(markup).toContain("Set up your workspace");
    expect(markup).toContain("Step 1 of 2");
    expect(markup).toContain("You can change providers at any time in Settings.");
    expect(markup).toContain("Alchemy");
    expect(markup).toContain("Helius");
    expect(markup).toContain("QuickNode");
    expect(markup).toContain("Triton");
    expect(markup).toContain("Validation Cloud");
    expect(markup).toContain("/provider-logos/alchemy.svg");
    expect(markup).toContain("/provider-logos/helius.svg");
    expect(markup).toContain("/provider-logos/quicknode.svg");
    expect(markup).toContain("/provider-logos/triton.svg");
    expect(markup).toContain("/provider-logos/validation-cloud.svg");
    expect(markup).not.toContain("SDP RPC");
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(5);
    expect(markup).toContain('data-organization-onboarding-actions="true"');
    expect(markup).toContain("bg-surface-raised/95");
    expect(markup).not.toContain("bg-white/95");
  });

  it("resumes at custody and only renders generally available providers", () => {
    const markup = renderFlow("custody");

    expect(markup).toContain("Step 2 of 2");
    expect(markup).toContain("Choose your custody provider");
    expect(markup).toContain("You can change providers at any time in Settings.");
    expect(markup).toContain("Privy");
    expect(markup).toContain("Coinbase CDP");
    expect(markup).toContain("Para");
    expect(markup).toContain("Turnkey");
    expect(markup).not.toContain("Fireblocks");
    expect(markup).toContain("Finish setup");
  });
});
