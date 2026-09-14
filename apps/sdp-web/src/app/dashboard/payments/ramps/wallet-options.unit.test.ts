import type { PaymentsDashboardWallet } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { walletComboboxOptions } from "./wallet-options";

describe("walletComboboxOptions", () => {
  it("uses exact wallet ids and keeps duplicate Provider ids selectable", () => {
    const wallets: PaymentsDashboardWallet[] = [
      {
        id: "cwlt_1",
        walletId: "privy_shared",
        publicKey: "address_1",
        label: "Primary",
        isRuntimeExecutionAllowed: true,
      },
      {
        id: "cwlt_2",
        walletId: "privy_shared",
        publicKey: "address_2",
        label: null,
        isRuntimeExecutionAllowed: true,
      },
    ];

    expect(walletComboboxOptions(wallets)).toMatchObject([
      { value: "cwlt_1", label: "Primary" },
      { value: "cwlt_2", label: "address_2" },
    ]);
  });

  it("marks signing unavailable without hiding the same wallet from receiving", () => {
    const wallets: PaymentsDashboardWallet[] = [
      {
        id: "cwlt_connection",
        walletId: "privy_shared",
        custodyConnectionId: "cconn_other",
        publicKey: "address_1",
        label: "Treasury",
        isRuntimeExecutionAllowed: false,
      },
    ];

    expect(walletComboboxOptions(wallets, "Signing unavailable")).toMatchObject([
      { value: "cwlt_connection", label: "Treasury", badge: "Signing unavailable" },
    ]);
    expect(walletComboboxOptions(wallets)).toEqual([
      { value: "cwlt_connection", label: "Treasury", description: undefined },
    ]);
  });
});
