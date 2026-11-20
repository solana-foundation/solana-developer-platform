// @vitest-environment jsdom
import type { EarnStrategy } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { EarnCoreActionModal, EarnOperationReview } from "./earn-core-action-modal";

const mocks = vi.hoisted(() => ({
  deposit: vi.fn(),
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
  it("rejects slippage beyond the API limit before preparing a transaction", async () => {
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("slippage"), { target: { value: "501" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(screen.getByText("invalidSlippage")).toBeDefined();
    expect(mocks.deposit).not.toHaveBeenCalled();
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
});
