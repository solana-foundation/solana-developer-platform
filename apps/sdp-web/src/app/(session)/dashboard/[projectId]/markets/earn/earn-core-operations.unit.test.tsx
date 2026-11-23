// @vitest-environment jsdom
import type { Operation } from "@sdp/types/operations";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EarnCoreOperations } from "./earn-core-operations";

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
