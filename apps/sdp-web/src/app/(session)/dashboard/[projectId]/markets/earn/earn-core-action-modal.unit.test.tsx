// @vitest-environment jsdom
import type { EarnStrategy } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { EarnCoreActionModal, EarnOperationReview } from "./earn-core-action-modal";

const mocks = vi.hoisted(() => ({
  deposit: vi.fn(),
  execute: vi.fn(),
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
    nextAction: { type: "execute" },
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
  it("prepares live terms before a separate execution approval", async () => {
    mocks.deposit.mockResolvedValue(operation());
    render(<EarnCoreActionModal kind="deposit" strategy={strategy} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("amount"), { target: { value: "10" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "review" })));
    expect(mocks.deposit).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(screen.getByText("requested")).toBeDefined();
    mocks.execute.mockResolvedValue(
      operation({ status: "submitted", nextAction: { type: "wait", reason: "Confirming" } })
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "execute" })));
    expect(mocks.execute).toHaveBeenCalledWith(
      "operation",
      { actionId: "action", version: 1 },
      expect.any(String)
    );
  });

  it("reviews the current deposit step in its own mint after a prerequisite swap", () => {
    const step = operation();
    step.terms.inputAmount = {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      value: "24.8",
    };
    step.terms.description = "The swap finalized. Review the deposit before execution.";
    render(<EarnOperationReview operation={step} />);
    expect(screen.getByText("stepInput")).toBeDefined();
    expect(screen.getByText("$24.80")).toBeDefined();
    expect(
      screen.getByText("The swap finalized. Review the deposit before execution.")
    ).toBeDefined();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("shows provider approval instructions without inventing a transaction or completing", () => {
    render(
      <EarnOperationReview
        operation={operation({
          status: "awaiting_approval",
          nextAction: {
            type: "approve_in_provider",
            provider: "fireblocks",
            providerTransactionId: "proposal",
            instructions: "Approve in Fireblocks",
            handoffUrl: null,
          },
        })}
      />
    );
    expect(screen.getByText("Approve in Fireblocks")).toBeDefined();
    expect(screen.queryByRole("button", { name: "execute" })).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refreshes an explicitly replaceable action without executing it", async () => {
    mocks.refresh.mockResolvedValue(operation({ actionId: "replacement", version: 2 }));
    render(
      <EarnOperationReview
        operation={operation({ status: "awaiting_approval", nextAction: { type: "refresh" } })}
      />
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "refreshTerms" })));
    expect(mocks.refresh).toHaveBeenCalledWith("operation", expect.any(String));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("never refreshes an exposed external message merely because it is prepared", () => {
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

  it("keeps an uncertain approval observation-only", () => {
    render(
      <EarnOperationReview
        operation={operation({
          status: "awaiting_approval",
          nextAction: { type: "wait", reason: "Provider outcome is unknown" },
        })}
      />
    );
    expect(screen.queryByRole("button", { name: "refreshTerms" })).toBeNull();
    expect(screen.queryByRole("button", { name: "execute" })).toBeNull();
  });

  it("uses a new cancellation key after acknowledgement but reuses a lost response key", async () => {
    mocks.cancel.mockRejectedValueOnce(new Error("Lost response"));
    mocks.cancel.mockResolvedValue(
      operation({ status: "settling", nextAction: { type: "wait", reason: "Settling" } })
    );
    render(
      <EarnOperationReview
        operation={operation({
          status: "settling",
          nextAction: { type: "wait", reason: "Settling" },
        })}
      />
    );
    const cancel = screen.getByRole("button", { name: "cancel" });
    await act(async () => fireEvent.click(cancel));
    await act(async () => fireEvent.click(cancel));
    await act(async () => fireEvent.click(cancel));
    const keys = mocks.cancel.mock.calls.map((call) => call[1]);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

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

  it("refuses approval of expired terms", () => {
    const expired = operation();
    expired.terms.expiresAt = "2000-01-01T00:00:00.000Z";
    render(<EarnOperationReview operation={expired} />);
    expect(screen.getByRole("button", { name: "execute" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("expired")).toBeDefined();
  });
});
