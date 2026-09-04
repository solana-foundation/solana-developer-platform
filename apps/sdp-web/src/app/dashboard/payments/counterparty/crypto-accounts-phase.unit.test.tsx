import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    key === "DashboardPayments.counterparty.stepProgress"
      ? `Step ${values?.current} of ${values?.total}`
      : key,
}));

vi.mock("./counterparty-create-context", () => ({
  useCounterpartyCreate: () => ({
    createdCounterparty: {
      id: "cp_123",
      displayName: "Northstar Labs",
    },
    finish: vi.fn(),
  }),
}));

vi.mock("./crypto-account-form", () => ({
  CryptoAccountForm: () => <div data-crypto-account-form />,
}));

import { CryptoAccountsPhase } from "./crypto-accounts-phase";

const steps = [
  { label: "Basics", title: "Basic information" },
  { label: "Crypto wallet", title: "Add a crypto account" },
] as const;

describe("CryptoAccountsPhase", () => {
  it("keeps the standalone optional phase inside the shared authoring frame", () => {
    const markup = renderToStaticMarkup(<CryptoAccountsPhase embedded={false} steps={steps} />);

    expect(markup).toContain("data-wizard-frame");
    expect(markup).toContain("data-wizard-stepper");
    expect(markup).toContain("data-wizard-scroll-region");
    expect(markup).toContain("data-wizard-actions");
    expect(markup).toContain("Step 2 of 2");
    expect(markup).toContain("data-crypto-account-form");
  });

  it("uses a natural-height layout when embedded in a dialog", () => {
    const markup = renderToStaticMarkup(<CryptoAccountsPhase embedded steps={steps} />);

    expect(markup).not.toContain("data-wizard-frame");
    expect(markup).not.toContain("overflow-y-auto");
    expect(markup).toContain("data-crypto-account-form");
  });
});
