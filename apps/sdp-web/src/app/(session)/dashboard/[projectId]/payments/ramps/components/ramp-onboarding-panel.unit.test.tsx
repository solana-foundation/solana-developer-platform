import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider, useTranslations } from "@/i18n/provider";
import { onboardingPanelCopy, RampOnboardingPanel } from "./ramp-onboarding-panel";

/** The provider step's choice: the panel for an onboarding answer, nothing for any other. */
function ProviderStepPanel({ requirements }: { requirements: CounterpartyRequirements }) {
  const t = useTranslations();
  const copy = onboardingPanelCopy(requirements, t);
  return copy === null ? <p>no panel</p> : <RampOnboardingPanel copy={copy} />;
}

function render(requirements: CounterpartyRequirements): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ProviderStepPanel requirements={requirements} />
    </I18nProvider>
  );
}

describe("RampOnboardingPanel", () => {
  it.each([
    { provider: "hercle", direction: "onramp", status: "ready" },
    { provider: "hercle", direction: "onramp", status: "collect", fields: [] },
    { provider: "hercle", direction: "offramp", status: "unsupported", reason: "On-ramp only." },
  ] satisfies CounterpartyRequirements[])("leaves $status to the wizard", (requirements) => {
    expect(render(requirements)).toBe("<p>no panel</p>");
  });

  it("asks the business to verify while Hercle waits for it, without a link in the page", () => {
    const markup = render({
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://verify.hercle.test/acct_1",
    });

    expect(markup).toContain("Verify your business");
    // The footer opens the hosted verification through the trusted-destination guard.
    expect(markup).not.toContain("verify.hercle.test");
  });

  it("spins while Hercle reviews the business", () => {
    const markup = render({
      provider: "hercle",
      direction: "onramp",
      status: "customer_verifying",
    });

    expect(markup).toContain("Verification in review");
    expect(markup).toContain("animate-spin");
  });

  it("states a refused verification without a spinner", () => {
    const markup = render({
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_failed",
    });

    expect(markup).toContain("Business verification was not approved");
    expect(markup).toContain("text-error");
    expect(markup).not.toContain("animate-spin");
  });
});
