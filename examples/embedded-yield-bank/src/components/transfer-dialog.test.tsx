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
import type { YieldStrategy, YieldWithdrawalOptions } from "@/types";
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

const queuedWithdrawalOptions: YieldWithdrawalOptions = {
  positionId: "position_1",
  instant: false,
  providerOrder: false,
  queued: true,
  withdrawAuthority: "withdraw_authority",
  queueState: "queue_state",
  queueAsset: {
    assetMint: "usdc_mint",
    allowWithdrawals: true,
    secondsToMaturity: 60,
    minimumSecondsToDeadline: 360,
    maximumSecondsToDeadline: 7_776_000,
    minimumDiscountBps: 25,
    maximumDiscountBps: 75,
    minimumShares: "1",
    shareDecimals: 6,
  },
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
        feesPaidBy="northstar"
        busy={false}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Move to savings" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Amount"), {
      target: { value: "1" },
    });

    const submit = dialog.getByRole("button", { name: "Move to savings" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ amount: "1", route: "deposit" })
    );
  });

  it("keeps invalid queued withdrawal terms blocked", () => {
    render(
      <TransferDialog
        direction="to-checking"
        symbol="USDC"
        available="10"
        strategy={strategy}
        withdrawalOptions={queuedWithdrawalOptions}
        feesPaidBy="northstar"
        busy={false}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Move to checking" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Amount"), {
      target: { value: "1" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Adjust terms" }));
    fireEvent.change(dialog.getByLabelText("Max discount (%)"), {
      target: { value: "0" },
    });

    expect(
      (
        dialog.getByRole("button", {
          name: "Request withdrawal",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });
});
