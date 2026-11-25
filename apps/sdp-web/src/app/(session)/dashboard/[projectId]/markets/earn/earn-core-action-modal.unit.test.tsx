// @vitest-environment jsdom
import type { EarnStrategy, EarnVaultPosition } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { EarnCoreActionModal, EarnOperationReview } from "./earn-core-action-modal";

const mocks = vi.hoisted(() => ({
  deposit: vi.fn(),
  withdraw: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/i18n/provider", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key.split(".").at(-1),
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => ({ selectedProjectId: "project" }),
}));
vi.mock("@/lib/use-modal-focus", () => ({ useModalFocus: () => ({ current: null }) }));
vi.mock("./deposit/earn-funding-wallets", () => ({
  useEarnFundingWallets: () => ({
    wallets: [{ id: "wallet", isRuntimeExecutionAllowed: true, label: "Treasury" }],
  }),
  walletDisplayName: () => "Treasury",
}));
vi.mock("@/lib/earn-core-data", () => ({
  earnCoreClient: mocks,
  isEarnOperationTerminal: (operation: Operation) =>
    ["completed", "failed", "cancelled"].includes(operation.status),
  useEarnOperation: (_id: string, initial: Operation) => ({
    operation: initial,
    refresh: vi.fn(),
    update: vi.fn(),
  }),
}));

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "operation",
    kind: "earn.deposit",
    status: "prepared",
    environment: "sandbox",
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { walletId: "wallet" },
      amount: { mint: "usdc", value: "10" },
    },
    actionId: "action",
    version: 1,
    nextAction: { type: "submit" },
    terms: {
      expiresAt: null,
      estimate: { mint: "usdc", value: "9.99" },
      minimum: null,
      fees: null,
      options: [],
    },
    buildRef: null,
    resourceRef: null,
    result: null,
    canCancel: false,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T12:00:00.000Z",
    updatedAt: "2026-11-18T12:00:00.000Z",
    ...overrides,
  };
}
const strategy: EarnStrategy = {
  id: "strategy",
  name: "Strategy",
  provider: "provider",
  providerReference: "vault",
  sourceKind: "defi",
  depositMints: ["usdc"],
  apyType: "variable",
  liquidityTerm: "instant",
  status: "active",
  depositSlippage: null,
  withdrawalSlippage: null,
  hostCluster: "devnet",
  fundable: true,
  feeSponsored: false,
  createdAt: "2026-11-18T12:00:00Z",
  updatedAt: "2026-11-18T12:00:00Z",
};

function intermediatePosition(withdrawableAmount: string): EarnVaultPosition {
  return {
    id: "position",
    provider: "hastra",
    providerReference: "strategy",
    label: "Treasury holding",
    custodyWalletId: "wallet",
    tokenMint: "usdc",
    shareMint: "shares",
    feeSponsored: false,
    createdAt: "2026-11-18T00:00:00Z",
    closedAt: null,
    shares: "0",
    parIntermediate: {
      mint: "intermediate",
      amount: withdrawableAmount,
      withdrawableAmount,
      tokenValue: withdrawableAmount,
    },
  };
}

/** A tracked position whose every share sits in a provider withdrawal request's escrow. */
const escrowedPosition: EarnVaultPosition = {
  id: "position",
  provider: "veda",
  providerReference: "strategy",
  label: "Treasury holding",
  custodyWalletId: "wallet",
  tokenMint: "usdc",
  shareMint: "shares",
  feeSponsored: false,
  createdAt: "2026-11-18T00:00:00Z",
  closedAt: null,
  shares: "0",
};

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Earn operation review", () => {
  it("keeps an intermediate-All body and key through live balance changes and remounts", async () => {
    mocks.withdraw.mockRejectedValue(new Error("Response outcome unknown"));
    const view = render(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("10")}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "3" } });
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw.mock.calls[0]?.[0].amount).toEqual({
      kind: "intermediate",
      mint: "intermediate",
      value: "10",
    });
    view.rerender(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("12")}
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw.mock.calls[1]).toEqual(mocks.withdraw.mock.calls[0]);
    view.unmount();
    resetIdempotencyKeyStoresForTests();
    render(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("14")}
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw.mock.calls[2]).toEqual(mocks.withdraw.mock.calls[0]);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "customAmount" })));
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "5" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw.mock.calls[3]?.[0].amount.value).toBe("5");
    expect(mocks.withdraw.mock.calls[3]?.[1]).not.toBe(mocks.withdraw.mock.calls[0]?.[1]);
  });

  it("does not rebuild a corrupted retained preparation", async () => {
    mocks.withdraw.mockRejectedValue(new Error("Response outcome unknown"));
    render(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("10")}
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    const stored = sessionStorage.getItem("sdp:earn:core-actions:v1");
    expect(stored).not.toBeNull();
    const entries = JSON.parse(stored ?? "[]") as Array<{ id: string; value: string }>;
    for (const entry of entries) entry.value = "corrupted";
    sessionStorage.setItem("sdp:earn:core-actions:v1", JSON.stringify(entries));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/saved preparation is unavailable/)).toBeDefined();
  });

  it("retires the saved preparation body only after a successful response", async () => {
    mocks.withdraw.mockResolvedValue(operation());
    const view = render(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("10")}
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    view.unmount();
    render(
      <EarnCoreActionModal
        kind="withdraw"
        intermediate
        position={intermediatePosition("12")}
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw.mock.calls[1]?.[0].amount.value).toBe("12");
    expect(mocks.withdraw.mock.calls[1]?.[1]).not.toBe(mocks.withdraw.mock.calls[0]?.[1]);
  });

  it("opens a recovery exit with All selected and reaches the API's recovery route", async () => {
    const choice = operation({
      kind: "earn.withdraw",
      intent: { kind: "earn.withdraw", positionId: "position", amount: { kind: "all" } },
      nextAction: { type: "select_option" },
      terms: {
        expiresAt: null,
        estimate: null,
        minimum: null,
        fees: null,
        options: [
          {
            id: "recover_expired_escrow:request",
            label: "Recover expired escrowed shares",
            settlement: "instant",
            estimatedSeconds: null,
            mechanism: "recover_expired_escrow",
            amount: { mint: "shares", value: "10" },
            minimum: { mint: "shares", value: "10" },
          },
        ],
      },
    });
    mocks.withdraw.mockResolvedValue(choice);
    mocks.refresh.mockResolvedValue(
      operation({ ...choice, actionId: "recovery", version: 2, nextAction: { type: "submit" } })
    );
    render(
      <EarnCoreActionModal
        kind="withdraw"
        position={escrowedPosition}
        defaultWithdrawAll
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("amount")).toBeNull();
    expect(screen.getByRole("radio", { name: "withdrawAll" })).toHaveProperty("checked", true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw).toHaveBeenCalledExactlyOnceWith(
      { positionId: "position", amount: { kind: "all" }, slippageBps: 50 },
      expect.any(String)
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "route" }));
    await user.click(
      await screen.findByRole("option", { name: "Recover expired escrowed shares" })
    );
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(
      "operation",
      { actionId: "action", version: 1, optionId: "recover_expired_escrow:request" },
      expect.any(String)
    );
    expect(await screen.findByRole("button", { name: "submit" })).toBeDefined();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shows the API's refusal when nothing is recoverable yet, and retries the same request", async () => {
    mocks.withdraw.mockRejectedValue(
      new Error("No supported withdrawal route is currently available")
    );
    render(
      <EarnCoreActionModal
        kind="withdraw"
        position={escrowedPosition}
        defaultWithdrawAll
        onClose={vi.fn()}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(screen.getByText("No supported withdrawal route is currently available")).toBeDefined();
    // The API stores no 400, so the same key prepares afresh once the escrow expires.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw).toHaveBeenCalledTimes(2);
    expect(mocks.withdraw.mock.calls[1]).toEqual(mocks.withdraw.mock.calls[0]);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects slippage beyond the API limit before preparing a transaction", async () => {
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("slippage"), { target: { value: "501" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(screen.getByText("invalidSlippage")).toBeDefined();
    expect(mocks.deposit).not.toHaveBeenCalled();
  });

  it("names a missing amount before an invalid slippage, and prepares nothing", async () => {
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("slippage"), { target: { value: "501" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(screen.getByText("positiveAmount")).toBeDefined();
    expect(screen.queryByText("invalidSlippage")).toBeNull();
    expect(mocks.deposit).not.toHaveBeenCalled();
  });

  it("prepares a deposit from the first eligible wallet and the strategy's mint", async () => {
    mocks.deposit.mockResolvedValue(operation());
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("slippage"), { target: { value: "75" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.deposit).toHaveBeenCalledExactlyOnceWith(
      {
        strategyId: "strategy",
        source: { walletId: "wallet" },
        amount: { mint: "usdc", value: "10" },
        slippageBps: 75,
      },
      expect.any(String)
    );
  });

  it("withdraws All without reading the hidden custom amount", async () => {
    mocks.withdraw.mockResolvedValue(operation());
    render(<EarnCoreActionModal kind="withdraw" position={escrowedPosition} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "not a number" } });
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "withdrawAll" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw).toHaveBeenCalledExactlyOnceWith(
      { positionId: "position", amount: { kind: "all" }, slippageBps: 50 },
      expect.any(String)
    );
  });

  it("prepares a share-denominated withdrawal from the unit picker", async () => {
    mocks.withdraw.mockResolvedValue(operation());
    render(<EarnCoreActionModal kind="withdraw" position={escrowedPosition} onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "amountUnit" }));
    await user.click(await screen.findByRole("option", { name: "shares" }));
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "2.5" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.withdraw).toHaveBeenCalledExactlyOnceWith(
      { positionId: "position", amount: { kind: "shares", value: "2.5" }, slippageBps: 50 },
      expect.any(String)
    );
  });

  it("locks the deposit's choices while its preparation is in flight", async () => {
    let finish: ((value: Operation) => void) | undefined;
    mocks.deposit.mockReturnValue(
      new Promise<Operation>((resolve) => {
        finish = resolve;
      })
    );
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    for (const label of ["wallet", "asset", "amount", "slippage"]) {
      expect(screen.getByLabelText(label).hasAttribute("disabled")).toBe(true);
    }
    await act(async () => finish?.(operation()));
  });

  it("locks the withdrawal's unit and All choice while its preparation is in flight", async () => {
    let finish: ((value: Operation) => void) | undefined;
    mocks.withdraw.mockReturnValue(
      new Promise<Operation>((resolve) => {
        finish = resolve;
      })
    );
    render(<EarnCoreActionModal kind="withdraw" position={escrowedPosition} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "2" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    const unit = screen.getByRole("combobox", { name: "amountUnit" });
    expect(unit.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("radio", { name: "withdrawAll" }).matches(":disabled")).toBe(true);
    await act(async () => finish?.(operation()));
  });

  it("lets the same withdrawal choice retry a failed preparation with the same key", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("Preparation unavailable"));
    mocks.refresh.mockResolvedValueOnce(operation({ actionId: "selected", version: 2 }));
    const choice = operation({
      nextAction: { type: "select_option" },
      terms: {
        expiresAt: null,
        estimate: null,
        minimum: null,
        fees: null,
        options: [
          {
            id: "instant",
            label: "Instant withdrawal",
            settlement: "instant",
            estimatedSeconds: 0,
          },
          {
            id: "delayed",
            label: "Standard withdrawal",
            settlement: "delayed",
            estimatedSeconds: 3600,
          },
        ],
      },
    });
    render(<EarnOperationReview operation={choice} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "route" }));
    await user.click(await screen.findByRole("option", { name: "Standard withdrawal" }));
    expect(screen.getByText("Preparation unavailable")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "route" }).textContent).toContain("chooseRoute");
    await user.click(screen.getByRole("combobox", { name: "route" }));
    await user.click(await screen.findByRole("option", { name: "Standard withdrawal" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh.mock.calls[0]).toEqual(mocks.refresh.mock.calls[1]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("prepares the selected withdrawal route before allowing its reviewed transaction to submit", async () => {
    let finishPreparation: ((value: Operation) => void) | undefined;
    mocks.refresh.mockReturnValue(
      new Promise<Operation>((resolve) => {
        finishPreparation = resolve;
      })
    );
    const choice = operation({
      kind: "earn.withdraw",
      intent: { kind: "earn.withdraw", positionId: "position", amount: { kind: "all" } },
      nextAction: { type: "select_option" },
      terms: {
        expiresAt: null,
        estimate: null,
        minimum: null,
        fees: null,
        options: [
          {
            id: "instant",
            label: "Instant withdrawal",
            settlement: "instant",
            estimatedSeconds: 0,
          },
          {
            id: "delayed",
            label: "Standard withdrawal",
            settlement: "delayed",
            estimatedSeconds: 3600,
          },
        ],
      },
    });
    const updated = vi.fn();
    const view = render(<EarnOperationReview operation={choice} onUpdated={updated} />);
    expect(screen.queryByRole("button", { name: "submit" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "route" }));
    await user.click(await screen.findByRole("option", { name: "Standard withdrawal" }));
    expect(mocks.refresh).toHaveBeenCalledWith(
      "operation",
      { actionId: "action", version: 1, optionId: "delayed" },
      expect.any(String)
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "route" }).hasAttribute("disabled")).toBe(true);
    const prepared = operation({
      ...choice,
      actionId: "selected-action",
      version: 2,
      nextAction: { type: "submit" },
      terms: {
        ...choice.terms,
        description: "Standard withdrawal, approximately one hour.",
        options: [],
      },
    });
    await act(async () => finishPreparation?.(prepared));
    expect(updated).toHaveBeenCalledWith(prepared);
    view.rerender(<EarnOperationReview operation={prepared} onUpdated={updated} />);
    expect(screen.getByText("Standard withdrawal, approximately one hour.")).toBeDefined();
    expect(mocks.submit).not.toHaveBeenCalled();
    mocks.submit.mockResolvedValue(
      operation({ ...prepared, status: "queued", nextAction: { type: "wait", reason: "Queued" } })
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "submit" })));
    expect(mocks.submit).toHaveBeenCalledWith(
      "operation",
      { actionId: "selected-action", version: 2 },
      expect.any(String)
    );
  });

  it("prepares live terms before a separate submission confirmation", async () => {
    mocks.deposit.mockResolvedValue(operation());
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.deposit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByText("requested")).toBeDefined();
    mocks.submit.mockResolvedValue(
      operation({ status: "submitted", nextAction: { type: "wait", reason: "Confirming" } })
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "submit" })));
    expect(mocks.submit).toHaveBeenCalledWith(
      "operation",
      { actionId: "action", version: 1 },
      expect.any(String)
    );
    expect(screen.getByText("Confirming")).toBeDefined();
  });

  it("does not replace a newer observed action with a late preparation response", async () => {
    let finishPreparation: ((value: Operation) => void) | undefined;
    mocks.refresh.mockReturnValue(
      new Promise<Operation>((resolve) => {
        finishPreparation = resolve;
      })
    );
    const initial = operation({ nextAction: { type: "refresh" } });
    const updated = vi.fn();
    const view = render(<EarnOperationReview operation={initial} onUpdated={updated} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "refreshTerms" })));
    view.rerender(
      <EarnOperationReview
        operation={operation({ actionId: "newer", version: 3 })}
        onUpdated={updated}
      />
    );
    await act(async () => finishPreparation?.(operation({ actionId: "stale", version: 2 })));
    expect(updated).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("reviews the prepared transaction input in its own mint", () => {
    const step = operation();
    step.terms.inputAmount = {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      value: "24.8",
    };
    step.terms.description = "Review the atomic swap and deposit.";
    render(<EarnOperationReview operation={step} />);
    expect(screen.getByText("stepInput")).toBeDefined();
    expect(screen.getByText("$24.80")).toBeDefined();
    expect(screen.getByText("Review the atomic swap and deposit.")).toBeDefined();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shows provider signing instructions without inventing a transaction or completing", () => {
    render(
      <EarnOperationReview
        operation={operation({
          status: "awaiting_signature",
          nextAction: {
            type: "sign_in_provider",
            provider: "fireblocks",
            providerTransactionId: "proposal",
            instructions: "Sign in Fireblocks",
            handoffUrl: null,
          },
        })}
      />
    );
    expect(screen.getByText("Sign in Fireblocks")).toBeDefined();
    expect(screen.queryByRole("button", { name: "submit" })).toBeNull();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refreshes an explicitly replaceable action without submitting it", async () => {
    mocks.refresh.mockResolvedValue(operation({ actionId: "replacement", version: 2 }));
    render(<EarnOperationReview operation={operation({ nextAction: { type: "refresh" } })} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "refreshTerms" })));
    expect(mocks.refresh).toHaveBeenCalledWith(
      "operation",
      { actionId: "action", version: 1 },
      expect.any(String)
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("never refreshes an exposed wallet message merely because it is prepared", () => {
    render(
      <EarnOperationReview
        operation={operation({
          nextAction: {
            type: "sign_transaction",
            transaction: "unsigned",
            lastValidBlockHeight: "100",
            expiresAt: null,
          },
        })}
      />
    );
    expect(screen.queryByRole("button", { name: "refreshTerms" })).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["queued", "awaiting_signature", "submitted", "settling", "failed"] as const)(
    "never offers refreshed terms after a submission reaches %s",
    (status) => {
      render(
        <EarnOperationReview operation={operation({ status, nextAction: { type: "refresh" } })} />
      );
      expect(screen.queryByRole("button", { name: "refreshTerms" })).toBeNull();
      expect(mocks.refresh).not.toHaveBeenCalled();
    }
  );

  it("keeps an uncertain signature observation-only", () => {
    render(
      <EarnOperationReview
        operation={operation({
          status: "awaiting_signature",
          nextAction: { type: "wait", reason: "Provider outcome is unknown" },
        })}
      />
    );
    expect(screen.queryByRole("button", { name: "refreshTerms" })).toBeNull();
    expect(screen.queryByRole("button", { name: "submit" })).toBeNull();
  });

  it("retries cancellation of an unsubmitted preparation with its saved key", async () => {
    mocks.cancel.mockRejectedValueOnce(new Error("Lost response"));
    const cancelled = operation({ status: "cancelled", nextAction: null });
    mocks.cancel.mockResolvedValue(cancelled);
    const view = render(
      <EarnOperationReview operation={operation({ version: 2, canCancel: true })} />
    );
    const cancel = screen.getByRole("button", { name: "cancel" });
    await act(async () => fireEvent.click(cancel));
    await act(async () => fireEvent.click(cancel));
    const keys = mocks.cancel.mock.calls.map((call) => call[1]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    view.rerender(<EarnOperationReview operation={cancelled} />);
    expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
  });

  it.each(["queued", "awaiting_signature", "submitted", "settling", "prepared"] as const)(
    "hides cancellation when SDP forbids it for a %s operation, including refreshed preparations",
    (status) => {
      render(
        <EarnOperationReview operation={operation({ status, version: 3, canCancel: false })} />
      );
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
      expect(mocks.cancel).not.toHaveBeenCalled();
    }
  );

  it("blocks preparation when its retry key cannot be saved", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.deposit).not.toHaveBeenCalled();
    expect(screen.getByText(/Enable browser storage/)).toBeDefined();
  });

  it("refuses submission of expired terms", () => {
    const expired = operation();
    expired.terms.expiresAt = "2000-01-01T00:00:00.000Z";
    render(<EarnOperationReview operation={expired} />);
    expect(screen.getByRole("button", { name: "submit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("expired")).toBeDefined();
  });

  it("reads amounts in the strategy's share mint as shares and leaves other mints as they are", () => {
    const quoted = operation({
      terms: {
        expiresAt: null,
        estimate: { mint: "shares", value: "9.99" },
        minimum: { mint: "unlisted", value: "9.5" },
        fees: null,
        options: [],
      },
    });
    render(<EarnOperationReview operation={quoted} shareMint="shares" />);
    expect(screen.getByText("9.99 shareUnit")).toBeDefined();
    expect(screen.getByText(/^9\.5 /).textContent).not.toContain("share");
    cleanup();
    render(<EarnOperationReview operation={quoted} />);
    expect(screen.queryByText("9.99 shareUnit")).toBeNull();
    expect(screen.getByText(/^9\.99 /)).toBeDefined();
  });

  it("ends a finished operation with one exit: done when completed, close otherwise", () => {
    const onDone = vi.fn();
    render(
      <EarnOperationReview
        operation={operation({ status: "completed", nextAction: null })}
        onDone={onDone}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "done" }));
    expect(onDone).toHaveBeenCalledOnce();
    cleanup();
    render(
      <EarnOperationReview
        operation={operation({ status: "failed", nextAction: null })}
        onDone={onDone}
      />
    );
    expect(screen.getByRole("button", { name: "close" })).toBeDefined();
    cleanup();
    render(
      <EarnOperationReview operation={operation({ status: "completed", nextAction: null })} />
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets accepted work continue in activity, but not an undecided preparation", () => {
    const onDone = vi.fn();
    render(
      <EarnOperationReview
        operation={operation({
          status: "submitted",
          nextAction: { type: "wait", reason: "Confirming" },
        })}
        onDone={onDone}
      />
    );
    expect(screen.getByText("continuesInActivity")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onDone).toHaveBeenCalledOnce();
    cleanup();
    render(
      <EarnOperationReview
        operation={operation({
          nextAction: { type: "select_option" },
          terms: {
            expiresAt: null,
            estimate: null,
            minimum: null,
            fees: null,
            options: [
              {
                id: "direct",
                label: "Direct withdrawal",
                settlement: "instant",
                estimatedSeconds: null,
              },
            ],
          },
        })}
        onDone={onDone}
      />
    );
    expect(screen.queryByText("continuesInActivity")).toBeNull();
  });

  it("animates only short SDP-side waits", () => {
    const view = render(
      <EarnOperationReview
        operation={operation({ status: "queued", nextAction: { type: "wait", reason: "Queued" } })}
      />
    );
    expect(view.container.querySelector('[class*="earn-pending-halo"]')).not.toBeNull();
    expect(screen.getByText("Queued").className).toContain("earn-pending-breathe");
    cleanup();
    const settling = render(
      <EarnOperationReview
        operation={operation({
          status: "settling",
          nextAction: { type: "wait", reason: "Provider settlement" },
        })}
      />
    );
    expect(settling.container.querySelector('[class*="earn-pending-halo"]')).toBeNull();
    expect(screen.getByText("Provider settlement").className).not.toContain("earn-pending");
  });
});
