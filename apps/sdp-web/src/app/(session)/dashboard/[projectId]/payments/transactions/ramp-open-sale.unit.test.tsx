// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { RampOpenSale } from "./ramp-open-sale";
import type { PaymentTransferDetail } from "./transaction-detail.data";

// A member who may write; the read-only cases live with each component's own viewer tests.
vi.mock("@/contexts/dashboard-workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/dashboard-workspace-context")>()),
  useCanWrite: () => true,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const DEVNET_USDC = requiredWellKnownMint("USDC", "devnet");
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
    render(<RampOpenSale transfer={sale({})} walletLabel="Treasury" />, { wrapper });

    expect(screen.getByText(DEPOSIT_ADDRESS)).toBeTruthy();
    expect(screen.getByText("25 USDC")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Send 25 USDC" }));
    expect(screen.getByText("Send 25.00 USDC?")).toBeTruthy();
    // The confirmation names the wallet that pays, not only where the deposit goes.
    expect(screen.getByText("Treasury")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));

    await userEvent.click(screen.getByRole("button", { name: "Cancel payout" }));
    expect(screen.getByText("Cancel this transaction?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("holds Send while the sale is being canceled", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
    render(<RampOpenSale transfer={sale({})} walletLabel="Treasury" />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: "Cancel payout" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel transaction" }));

    expect(screen.getByRole("button", { name: "Send 25 USDC" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel payout" })).toHaveProperty("disabled", true);
  });

  it("offers only Cancel while the provider has not named a deposit address", () => {
    render(
      <RampOpenSale
        transfer={sale({ status: "pending", cryptoDeposit: undefined })}
        walletLabel="Treasury"
      />,
      {
        wrapper,
      }
    );

    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel payout" })).toBeTruthy();
  });

  it("shows nothing once the sale can no longer be funded", () => {
    const { container } = render(
      <RampOpenSale transfer={sale({ status: "settling" })} walletLabel="Treasury" />,
      {
        wrapper,
      }
    );

    expect(container.textContent).toBe("");
  });
});
