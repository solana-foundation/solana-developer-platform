// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { YieldStrategy } from "@/types";
import { TransferDialog } from "./transfer-dialog";

const strategy: YieldStrategy = {
  id: "strategy_1",
  provider: "kamino",
  providerReference: "vault_1",
  name: "Kamino Vault USDC",
  sourceKind: "defi",
  depositMints: ["usdc_mint"],
  shareMint: "share_mint",
  currentApy: "0.05",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "devnet",
  fundable: true,
  depositSlippage: null,
  withdrawalSlippage: null,
};

afterEach(cleanup);

describe("TransferDialog", () => {
  it("enables and submits a deposit after an amount is entered", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TransferDialog
        direction="to-savings"
        symbol="USDC"
        available="18.31"
        strategy={strategy}
        busy={false}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Move to savings" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Amount"), {
      target: { value: "1" },
    });

    const submit = dialog.getByRole("button", { name: "Review terms" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ amount: "1" }));
  });

  it("requests current withdrawal terms before offering execution or route selection", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TransferDialog
        direction="to-checking"
        symbol="USDC"
        available="10"
        strategy={strategy}
        busy={false}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to checking" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByRole("radio")).toBeNull();
    fireEvent.change(dialog.getByLabelText("Amount"), {
      target: { value: "1" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Review terms" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ amount: "1" }));
  });
});
