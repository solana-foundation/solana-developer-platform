// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EarnOperation } from "@/lib/core-operation";
import { OperationActivity } from "./operation-activity";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/core-api", () => ({
  refreshPreparedOperation: mocks.refresh,
  submitPreparedOperation: mocks.submit,
  requestOperationCancellation: mocks.cancel,
}));
const operation: EarnOperation = {
  id: "operation",
  kind: "earn.deposit",
  status: "awaiting_signature",
  intent: {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { ownerAddress: "owner" },
    amount: { mint: "usdc", value: "10" },
  },
  actionId: "action",
  version: 1,
  nextAction: { type: "refresh" },
  terms: {
    expiresAt: null,
    estimate: null,
    minimum: null,
    fees: null,
    options: [],
  },
  resourceRef: null,
  result: null,
  canCancel: false,
  cancelRequestedAt: null,
  error: null,
  createdAt: "2026-11-18T12:00:00Z",
  updatedAt: "2026-11-18T12:00:00Z",
};
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
it.each([
  "queued",
  "awaiting_signature",
  "submitted",
  "settling",
  "prepared",
] as const)(
  "hides cancellation when SDP forbids it for a %s operation",
  (status) => {
    render(
      <OperationActivity
        operations={[{ ...operation, status, version: 3, canCancel: false }]}
        strategyName="Strategy"
        symbol="USDC"
        tokenMint="usdc"
        onUpdated={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  }
);

it("allows cancellation only for an unsubmitted preparation advertised as cancellable", async () => {
  const choice: EarnOperation = {
    ...operation,
    status: "prepared",
    version: 2,
    nextAction: { type: "select_option" },
    canCancel: true,
  };
  const cancelled = {
    ...choice,
    status: "cancelled",
    nextAction: null,
    canCancel: false,
  };
  mocks.cancel.mockResolvedValue(cancelled);
  render(
    <OperationActivity
      operations={[choice]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  );
  expect(mocks.cancel).toHaveBeenCalledWith(choice);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("keeps the same route selectable after preparation fails", async () => {
  const choice: EarnOperation = {
    ...operation,
    status: "prepared",
    nextAction: { type: "select_option" },
    terms: {
      ...operation.terms,
      options: [
        { id: "instant", label: "Instant withdrawal", settlement: "instant" },
        { id: "delayed", label: "Standard withdrawal", settlement: "delayed" },
      ],
    },
  };
  mocks.refresh.mockRejectedValueOnce(new Error("Preparation unavailable"));
  mocks.refresh.mockResolvedValueOnce({
    ...choice,
    actionId: "selected",
    version: 2,
  });
  render(
    <OperationActivity
      operations={[choice]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Withdrawal route",
  });
  await act(async () =>
    fireEvent.change(select, { target: { value: "delayed" } })
  );
  expect(select.value).toBe("");
  expect(select.disabled).toBe(false);
  await act(async () =>
    fireEvent.change(select, { target: { value: "delayed" } })
  );
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(mocks.refresh.mock.calls[0]).toEqual(mocks.refresh.mock.calls[1]);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("offers explicitly safe refresh and requires a separate submission confirmation", async () => {
  const prepared: EarnOperation = { ...operation, status: "prepared" };
  mocks.refresh.mockResolvedValue({
    ...operation,
    status: "prepared",
    nextAction: { type: "submit" },
  });
  const updated = vi.fn();
  render(
    <OperationActivity
      operations={[prepared]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={updated}
    />
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Refresh terms" }))
  );
  expect(mocks.refresh).toHaveBeenCalledWith(prepared, undefined);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(updated).toHaveBeenCalledTimes(1);
});

it.each([
  "queued",
  "awaiting_signature",
  "submitted",
  "settling",
  "failed",
] as const)(
  "never offers refreshed terms after a submission reaches %s",
  (status) => {
    render(
      <OperationActivity
        operations={[{ ...operation, status }]}
        strategyName="Strategy"
        symbol="USDC"
        tokenMint="usdc"
        onUpdated={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Refresh terms" })).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  }
);
it("keeps uncertain signing attempts observation-only", () => {
  render(
    <OperationActivity
      operations={[
        {
          ...operation,
          nextAction: { type: "wait", reason: "Provider outcome unknown" },
        },
      ]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  expect(screen.queryByRole("button", { name: "Refresh terms" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm and submit" })
  ).toBeNull();
});

it("shows provider signing as the signature step without another Earn confirmation", () => {
  render(
    <OperationActivity
      operations={[
        {
          ...operation,
          status: "awaiting_signature",
          nextAction: {
            type: "sign_in_provider",
            provider: "fireblocks",
            providerTransactionId: "proposal",
            instructions: "Sign in Fireblocks",
            handoffUrl: null,
          },
        },
      ]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  expect(screen.getByText("Waiting for a signature")).toBeDefined();
  expect(screen.getByText("Sign in Fireblocks")).toBeDefined();
  expect(
    screen.queryByRole("button", { name: "Confirm and submit" })
  ).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it("prepares a selected withdrawal route immediately and requires final review before submission", async () => {
  const choice: EarnOperation = {
    ...operation,
    status: "prepared",
    kind: "earn.withdraw",
    intent: {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    },
    nextAction: { type: "select_option" },
    terms: {
      ...operation.terms,
      options: [
        { id: "instant", label: "Instant withdrawal", settlement: "instant" },
        { id: "delayed", label: "Standard withdrawal", settlement: "delayed" },
      ],
    },
  };
  const prepared: EarnOperation = {
    ...choice,
    actionId: "prepared-action",
    version: 2,
    nextAction: {
      type: "sign_transaction",
      transaction: "unsigned",
      lastValidBlockHeight: "100",
      expiresAt: null,
    },
    terms: {
      ...choice.terms,
      description: "Standard withdrawal, approximately one hour.",
      options: [],
    },
  };
  mocks.refresh.mockResolvedValue(prepared);
  const props = {
    strategyName: "Strategy",
    symbol: "USDC",
    tokenMint: "usdc",
    onUpdated: vi.fn(),
  };
  const view = render(<OperationActivity {...props} operations={[choice]} />);
  expect(
    screen.queryByRole("button", { name: "Confirm and submit" })
  ).toBeNull();
  await act(async () =>
    fireEvent.change(
      screen.getByRole("combobox", { name: "Withdrawal route" }),
      { target: { value: "delayed" } }
    )
  );
  expect(mocks.refresh).toHaveBeenCalledWith(choice, "delayed");
  expect(mocks.submit).not.toHaveBeenCalled();
  view.rerender(<OperationActivity {...props} operations={[prepared]} />);
  expect(
    screen.getByText("Standard withdrawal, approximately one hour.")
  ).toBeDefined();
  expect(mocks.submit).not.toHaveBeenCalled();
  mocks.submit.mockResolvedValue({
    ...prepared,
    status: "queued",
    nextAction: { type: "wait", reason: "Queued" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Confirm and submit" }))
  );
  expect(mocks.submit).toHaveBeenCalledWith(prepared);
});

it("reports recovered shares without presenting them as USDC proceeds", () => {
  render(
    <OperationActivity
      operations={[
        {
          ...operation,
          kind: "earn.withdraw",
          intent: {
            kind: "earn.withdraw",
            positionId: "position",
            amount: { kind: "all" },
          },
          status: "completed",
          nextAction: null,
          result: {
            positionId: "position",
            signature: "cancel-signature",
            source: { ownerAddress: "owner" },
            settledAmount: { mint: "share-token", value: "3" },
            settlementOutcome: "recovered",
          },
        },
      ]}
      strategyName="Strategy"
      symbol="USDC"
      tokenMint="usdc"
      onUpdated={vi.fn()}
    />
  );
  expect(screen.getByText(/^Recovered:/).textContent).not.toContain("USDC");
  expect(screen.queryByText(/^Delivered:/)).toBeNull();
});
