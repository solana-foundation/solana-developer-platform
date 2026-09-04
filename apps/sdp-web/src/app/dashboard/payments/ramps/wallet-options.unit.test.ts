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
      },
      {
        id: "cwlt_2",
        walletId: "privy_shared",
        publicKey: "address_2",
        label: null,
      },
    ];

    expect(walletComboboxOptions(wallets)).toMatchObject([
      { value: "cwlt_1", label: "Primary" },
      { value: "cwlt_2", label: "address_2" },
    ]);
  });
});
