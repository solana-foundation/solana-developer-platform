// @vitest-environment jsdom

import type { PrivateChannelTransfer } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TransferProgress } from "./transfer-progress";

function makeTransfer(overrides: Partial<PrivateChannelTransfer> = {}): PrivateChannelTransfer {
  return {
    id: "pct_progress",
    organizationId: "org_test",
    projectId: "project_test",
    instanceId: "pci_test",
    channelId: "pch_test",
    walletId: "wallet_sender",
    sender: "Sender1111111111111111111111111111111111",
    recipient: "Recipient11111111111111111111111111111111",
    mint: "Usdc111111111111111111111111111111111111",
    amount: "1.25",
    status: "confirmed",
    signature: "private-signature",
    failureReason: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function renderProgress(props: Partial<Parameters<typeof TransferProgress>[0]> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TransferProgress transfer={makeTransfer()} onReset={vi.fn()} {...props} />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("TransferProgress", () => {
  it("reports a confirmed transfer as final", () => {
    renderProgress({ senderLabel: "Sender wallet", recipientLabel: "Recipient wallet" });

    expect(screen.getByText("Transfer confirmed")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText("private-signature")).toBeTruthy();
    expect(screen.getByText("Sender wallet")).toBeTruthy();
    expect(screen.getByText("Recipient wallet")).toBeTruthy();
  });

  // `submitted` means SPC took the transaction but never reported executing it, so
  // the UI must read as inconclusive — this is the state a silent dedup drop lands in.
  it("flags a submitted transfer as awaiting a result, not a success", () => {
    renderProgress({ transfer: makeTransfer({ status: "submitted" }) });

    expect(screen.getByText("Awaiting the transfer result")).toBeTruthy();
    expect(screen.getByText("Submitted")).toBeTruthy();
    expect(screen.queryByText("Transfer confirmed")).toBeNull();
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("shows the stored SPC error and offers a retry", () => {
    const onReset = vi.fn();
    renderProgress({
      transfer: makeTransfer({
        status: "failed",
        signature: null,
        failureReason: "SPC rejected transfer",
      }),
      onReset,
    });

    expect(screen.getByText("Transfer failed")).toBeTruthy();
    expect(screen.getByText("SPC rejected transfer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("flags a pending transfer as an unknown outcome rather than a success", () => {
    renderProgress({
      transfer: makeTransfer({ status: "pending", signature: null }),
    });

    expect(screen.getByText("Submission result unknown")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.queryByText("Transfer confirmed")).toBeNull();
  });
});
