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
  { label: "Personal", title: "Personal details" },
  { label: "Address", title: "Location" },
  { label: "Review", title: "Review and create" },
] as const;

describe("CryptoAccountsPhase", () => {
  it("keeps the standalone optional phase inside the shared authoring frame", () => {
    const markup = renderToStaticMarkup(<CryptoAccountsPhase embedded={false} steps={steps} />);

    expect(markup).toContain("data-payments-wizard-frame");
    expect(markup).toContain("data-payments-wizard-stepper");
    expect(markup).toContain("data-payments-wizard-scroll-region");
    expect(markup).toContain("data-payments-wizard-actions");
    expect(markup).toContain("Step 5 of 5");
    expect(markup).toContain("data-crypto-account-form");
    expect(markup).not.toContain("h-[70vh]");
  });

  it("preserves the compact self-scrolling layout when embedded in a dialog", () => {
    const markup = renderToStaticMarkup(<CryptoAccountsPhase embedded steps={steps} />);

    expect(markup).not.toContain("data-payments-wizard-frame");
    expect(markup).toContain("h-[70vh]");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("data-crypto-account-form");
  });
});
