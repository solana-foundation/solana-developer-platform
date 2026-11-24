// @vitest-environment jsdom
import type { Operation } from "@sdp/types/operations";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EarnCoreOperations, type EarnWithdrawalRecovery } from "./earn-core-operations";

const feed = vi.hoisted(() => ({
  operations: [] as Operation[],
  activeIds: [] as string[],
  error: undefined as Error | undefined,
  refresh: vi.fn(),
  loadMore: vi.fn(),
}));
vi.mock("@/lib/earn-core-data", () => ({
  useEarnOperations: () => feed,
  isEarnOperationTerminal: (operation: Operation) =>
    ["completed", "failed", "cancelled"].includes(operation.status),
}));
vi.mock("@/i18n/provider", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key.split(".").at(-1),
}));
vi.mock("./earn-core-action-modal", () => ({
  EarnOperationReview: () => <p>Waiting for settlement</p>,
}));

function operation(id: string, status: Operation["status"]): Operation {
  return {
    id,
    kind: "earn.withdraw",
    status,
    environment: "sandbox",
    intent: { kind: "earn.withdraw", positionId: "closed-position", amount: { kind: "all" } },
    actionId: "action",
    version: 1,
    nextAction: status === "completed" ? null : { type: "wait", reason: "Waiting" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: null,
    resourceRef: null,
    result: {
      positionId: "closed-position",
      strategyId: "strategy",
      source: { walletId: "wallet" },
      signature: "signature",
      settledAmount: null,
      settlementOutcome: null,
    },
    canCancel: false,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
  };
}

/** A withdrawal whose provider request holds its escrow. */
function requestOperation(
  status: Operation["status"],
  overrides: Partial<Operation> = {}
): Operation {
  return {
    ...operation("escrow", status),
    resourceRef: { kind: "earn.withdrawal_request", id: "request" },
    ...overrides,
  };
}

const escrowedPosition = { id: "closed-position", label: "Escrowed vault" };

beforeEach(() => {
  vi.clearAllMocks();
  feed.operations = [];
  feed.activeIds = [];
  feed.error = undefined;
});
afterEach(cleanup);

it("reports a visible completion when the feed wins before the detail poll", () => {
  const onUpdated = vi.fn();
  feed.operations = [operation("current", "settling")];
  const view = render(<EarnCoreOperations onUpdated={onUpdated} />);
  expect(onUpdated).not.toHaveBeenCalled();
  const completed = operation("current", "completed");
  feed.operations = [completed];
  view.rerender(<EarnCoreOperations onUpdated={onUpdated} />);
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(completed);
  expect(screen.queryByText("Waiting for settlement")).toBeNull();
  view.rerender(<EarnCoreOperations onUpdated={onUpdated} />);
  expect(onUpdated).toHaveBeenCalledTimes(1);
});

it("does not refresh historical completions or a different source's completed history", () => {
  const onUpdated = vi.fn();
  feed.operations = [operation("first-source", "settling")];
  const view = render(<EarnCoreOperations onUpdated={onUpdated} />);
  feed.operations = [operation("other-source", "completed")];
  view.rerender(<EarnCoreOperations onUpdated={onUpdated} />);
  expect(onUpdated).not.toHaveBeenCalled();
});

it("immediately reports a terminal projection returned by the active query", () => {
  const onUpdated = vi.fn();
  const completed = operation("just-completed", "completed");
  feed.operations = [completed];
  feed.activeIds = [completed.id];
  render(<EarnCoreOperations onUpdated={onUpdated} />);
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(completed);
});

it("keeps the strategy name after a full exit removes its position", () => {
  feed.operations = [operation("closed", "completed")];
  render(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      positions={[]}
      strategies={[{ id: "strategy", name: "Treasury strategy" }]}
    />
  );
  expect(screen.getByText("Treasury strategy")).toBeDefined();
});

it("keeps existing rows visible beside a failed background refresh", () => {
  feed.operations = [operation("current", "settling")];
  feed.error = new Error("Read unavailable");
  render(<EarnCoreOperations onUpdated={vi.fn()} />);
  expect(screen.getByText("Waiting for settlement")).toBeDefined();
  expect(screen.getByText("refreshFailed")).toBeDefined();
});

it("reopens the exit of a position whose shares a provider request holds", () => {
  const onOpen = vi.fn();
  feed.operations = [requestOperation("settling")];
  const view = render(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ positions: [escrowedPosition], onOpen }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "recoveryOptions" }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(escrowedPosition);
  // The entry comes from the feed, not the dialog, so a later poll or reload keeps it.
  feed.operations = [{ ...requestOperation("settling"), updatedAt: "2026-11-18T00:05:00Z" }];
  view.rerender(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ positions: [escrowedPosition], onOpen }}
    />
  );
  expect(screen.getByRole("button", { name: "recoveryOptions" })).toBeDefined();
});

it("finds the recorded position when the withdrawal named a discovered holding", () => {
  const onOpen = vi.fn();
  feed.operations = [
    requestOperation("settling", {
      intent: {
        kind: "earn.withdraw",
        positionId: "earn_discovered_holding",
        amount: { kind: "all" },
      },
    }),
  ];
  render(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ positions: [escrowedPosition], onOpen }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "recoveryOptions" }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(escrowedPosition);
});

it("keeps the action's height while the positions read decides whether it shows", () => {
  feed.operations = [requestOperation("settling")];
  const loading: EarnWithdrawalRecovery<typeof escrowedPosition> = {
    positions: [],
    onOpen: vi.fn(),
  };
  const view = render(<EarnCoreOperations onUpdated={vi.fn()} withdrawalRecovery={loading} />);
  const header = () => screen.getByRole("heading", { name: "withdraw" }).parentElement?.className;
  const reserved = header();
  expect(reserved).toContain("min-h-[var(--button-height-md)]");
  expect(screen.queryByRole("button", { name: "recoveryOptions" })).toBeNull();
  view.rerender(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ ...loading, positions: [escrowedPosition] }}
    />
  );
  expect(screen.getByRole("button", { name: "recoveryOptions" })).toBeDefined();
  expect(header()).toBe(reserved);
});

it("leaves recovery to the parent: no handler or an unlisted position offers none", () => {
  feed.operations = [requestOperation("settling")];
  const view = render(<EarnCoreOperations onUpdated={vi.fn()} positions={[escrowedPosition]} />);
  expect(screen.getByText("Escrowed vault")).toBeDefined();
  expect(screen.queryByRole("button", { name: "recoveryOptions" })).toBeNull();
  expect(screen.getByRole("heading", { name: "withdraw" }).parentElement?.className).not.toContain(
    "min-h-"
  );
  view.rerender(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ positions: [{ id: "other-position" }], onOpen: vi.fn() }}
    />
  );
  expect(screen.queryByRole("button", { name: "recoveryOptions" })).toBeNull();
});

it.each<[string, Operation]>([
  ["its request is still being created", requestOperation("submitted")],
  ["its request has resolved", requestOperation("completed")],
  [
    "a direct exit is settling",
    requestOperation("settling", { resourceRef: { kind: "earn.movement", id: "movement" } }),
  ],
  [
    "a deposit is settling",
    requestOperation("settling", {
      kind: "earn.deposit",
      intent: {
        kind: "earn.deposit",
        strategyId: "strategy",
        source: { walletId: "wallet" },
        amount: { mint: "usdc", value: "10" },
      },
    }),
  ],
])("offers no recovery when %s", (_, candidate) => {
  feed.operations = [candidate];
  render(
    <EarnCoreOperations
      onUpdated={vi.fn()}
      withdrawalRecovery={{ positions: [escrowedPosition], onOpen: vi.fn() }}
    />
  );
  expect(screen.queryByRole("button", { name: "recoveryOptions" })).toBeNull();
});
