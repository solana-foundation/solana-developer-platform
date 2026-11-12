// @vitest-environment jsdom

import type { PaymentRampQuote } from "@sdp/types/payments";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ManualInstructionsQuote } from "./manual-instructions-quote";

const HERCLE_QUOTE = {
  id: "ord_hercle",
  provider: "hercle",
  status: "pending",
  deliveryMode: "manual_instructions",
  expiresAt: "2026-10-30T10:15:00Z",
  paymentInstructions: [
    {
      provider: "hercle",
      kind: "fiat_funding",
      fiatCurrency: "EUR",
      bankAccount: {
        iban: "CH9300762011623852957",
        bic: "HRCLCHZZ",
        paymentReference: "HRC-ORD-1",
        payerAccountHolder: "Acme AG",
      },
      instructionsNotes: "Wire 100.00 EUR from a bank account held by Acme AG.",
    },
  ],
} as const satisfies PaymentRampQuote;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ManualInstructionsQuote", () => {
  it("names the account, the reference and the business the wire must come from", () => {
    render(<ManualInstructionsQuote amount="100" fiatCurrency="EUR" quote={HERCLE_QUOTE} />, {
      wrapper,
    });

    expect(screen.getByText("CH9300762011623852957")).toBeTruthy();
    expect(screen.getByText("HRC-ORD-1")).toBeTruthy();
    expect(screen.getByText("Acme AG")).toBeTruthy();
    expect(screen.getByText("Pay from an account held by")).toBeTruthy();
    expect(screen.getByText("Fund by")).toBeTruthy();
    // Hercle sent no bank name, so the row is left out rather than shown blank.
    expect(screen.queryByText("Bank name")).toBeNull();
  });

  it("copies the payment reference the sender types into their bank", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const copied = vi.spyOn(toast, "success");
    render(<ManualInstructionsQuote amount="100" fiatCurrency="EUR" quote={HERCLE_QUOTE} />, {
      wrapper,
    });

    await user.click(screen.getByRole("button", { name: "Copy Payment reference" }));

    expect(writeText).toHaveBeenCalledWith("HRC-ORD-1");
    expect(copied).toHaveBeenCalledWith("Payment reference copied.", { position: "bottom-right" });
  });
});
