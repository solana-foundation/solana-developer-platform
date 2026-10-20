// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RampOpenSale } from "./ramp-open-sale";
import type { PaymentTransferDetail } from "./transaction-detail.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEPOSIT_ADDRESS = "2HWz9YwbM56YK1EazmmxFivwRs4n8KND7c1p8eYxS2Ao";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function sale(overrides: Partial<PaymentTransferDetail>): PaymentTransferDetail {
  return {
    id: "xfr_open_sale",
    custodyWalletId: "cwlt_treasury",
    providerWalletId: "wallet_treasury",
    status: "awaiting_payment",
    signature: null,
    rampsMemo: {},
    type: "offramp",
    provider: "moonpay",
    token: DEVNET_USDC,
    amount: "25",
    cryptoDeposit: { destinationAddress: DEPOSIT_ADDRESS, amount: "25" },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RampOpenSale", () => {
  it("lets an open sale be funded or canceled from its page, confirming first", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<RampOpenSale transfer={sale({})} />, { wrapper });

    expect(screen.getByText(DEPOSIT_ADDRESS)).toBeTruthy();
    expect(screen.getByText("25 USDC")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Send 25 USDC" }));
    expect(screen.getByText("Send 25.00 USDC?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));

    await userEvent.click(screen.getByRole("button", { name: "Cancel payout" }));
    expect(screen.getByText("Cancel this transaction?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers only Cancel while the provider has not named a deposit address", () => {
    render(<RampOpenSale transfer={sale({ status: "pending", cryptoDeposit: undefined })} />, {
      wrapper,
    });

    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel payout" })).toBeTruthy();
  });

  it("shows nothing once the sale can no longer be funded", () => {
    const { container } = render(<RampOpenSale transfer={sale({ status: "settling" })} />, {
      wrapper,
    });

    expect(container.textContent).toBe("");
  });
});
