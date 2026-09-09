// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ActivityCard } from "./activity-card";
import type { RingsOperationSummary } from "./helius-rings.data";

const mocks = vi.hoisted(() => ({
  executeRingsOperation: vi.fn(),
  recheckRingsOperation: vi.fn(),
  retryRingsOperation: vi.fn(),
  voidRingsOperation: vi.fn(),
}));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  executeRingsOperation: mocks.executeRingsOperation,
  recheckRingsOperation: mocks.recheckRingsOperation,
  retryRingsOperation: mocks.retryRingsOperation,
  voidRingsOperation: mocks.voidRingsOperation,
}));

function operation(overrides: Partial<RingsOperationSummary> = {}): RingsOperationSummary {
  return {
    id: "hro_1",
    walletId: "hrw_1",
    opType: "withdraw",
    state: "indexing",
    assetMint: null,
    amountRaw: "1000",
    createdAt: "2026-08-27T22:25:57.530Z",
    failureCode: null,
    outerTxSignature: null,
    retryable: null,
    retryOfOperationId: null,
    ringProgramId: null,
    ...overrides,
  };
}

function renderCard(operations: RingsOperationSummary[]) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const onSelect = vi.fn();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ActivityCard
        operations={operations}
        projectRings={[]}
        onChanged={onChanged}
        onSelect={onSelect}
      />
    </I18nProvider>
  );
  return { onChanged, onSelect };
}

function spinners(): HTMLElement[] {
  return screen.queryAllByLabelText("Still settling");
}

beforeEach(() => {
  mocks.executeRingsOperation.mockResolvedValue({});
  mocks.recheckRingsOperation.mockResolvedValue({});
  mocks.retryRingsOperation.mockResolvedValue({});
  mocks.voidRingsOperation.mockResolvedValue({});
});

function signedFailure(): RingsOperationSummary {
  return operation({
    state: "failed",
    failureCode: "manual_reconciliation_required",
    outerTxSignature: "sig_1",
    retryable: false,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityCard", () => {
  it("marks an operation that is still settling", () => {
    renderCard([operation({ state: "indexing" })]);

    expect(spinners()).toHaveLength(1);
  });

  it("leaves a settled operation unmarked", () => {
    renderCard([operation({ state: "completed" })]);

    expect(spinners()).toHaveLength(0);
  });

  /**
   * Approval waits on a person, so a spinner there would turn forever. The row
   * offers the decision instead.
   */
  it("offers approval inline without implying work is underway", () => {
    renderCard([operation({ state: "approval_required" })]);

    expect(spinners()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Execute" })).toBeTruthy();
  });

  it("retries a retryable failure from its own row", async () => {
    const { onChanged } = renderCard([
      operation({ state: "failed", failureCode: "signer_failed", retryable: true }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.retryRingsOperation).toHaveBeenCalledWith("hro_1");
    expect(onChanged).toHaveBeenCalled();
  });

  /**
   * A signed failure may already have landed, so re-signing the same intent is
   * how it gets paid twice. Rechecking and voiding are the offers instead.
   */
  it("offers void rather than retry once bytes were signed", () => {
    renderCard([signedFailure()]);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Void" })).toBeTruthy();
  });

  /**
   * A frozen indexer produced exactly this row for transactions that had in
   * fact finalized. Asking again is free and reversible, so it is offered
   * beside the void rather than leaving absence as the only conclusion.
   */
  it("offers a recheck beside the void on a signed failure", async () => {
    const { onChanged } = renderCard([signedFailure()]);

    await userEvent.click(screen.getByRole("button", { name: "Check indexer" }));

    expect(mocks.recheckRingsOperation).toHaveBeenCalledWith("hro_1");
    expect(mocks.voidRingsOperation).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it("says the indexer is behind when a recheck still finds nothing", async () => {
    mocks.recheckRingsOperation.mockResolvedValue({
      operation: { ...signedFailure(), state: "failed" },
    });
    renderCard([signedFailure()]);

    await userEvent.click(screen.getByRole("button", { name: "Check indexer" }));

    // The row cannot change on a miss, so the callout is the only feedback
    // distinguishing "asked and still nothing" from a dead button.
    expect(await screen.findByText(/still has no record/)).toBeTruthy();
  });

  it("reports the operation settled when a recheck completes it", async () => {
    mocks.recheckRingsOperation.mockResolvedValue({
      operation: { ...signedFailure(), state: "completed" },
    });
    renderCard([signedFailure()]);

    await userEvent.click(screen.getByRole("button", { name: "Check indexer" }));

    expect(await screen.findByText(/caught up/)).toBeTruthy();
  });

  it("does not open the detail drawer when the row's action is used", async () => {
    const { onSelect } = renderCard([
      operation({ state: "failed", failureCode: "signer_failed", retryable: true }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the detail drawer for the row itself", async () => {
    const { onSelect } = renderCard([operation({ state: "completed" })]);

    await userEvent.click(screen.getByText("Withdraw"));

    expect(onSelect).toHaveBeenCalledWith("hro_1");
  });

  it("names both ends of a retry link and opens the other end", async () => {
    const { onSelect } = renderCard([
      operation({ id: "hro_2", state: "completed", retryOfOperationId: "hro_original" }),
      operation({ id: "hro_original", state: "failed", failureCode: "signer_failed" }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Retry of …original" }));

    expect(onSelect).toHaveBeenCalledWith("hro_original");
    expect(screen.getByRole("button", { name: "Retried as hro_2" })).toBeTruthy();
  });

  /**
   * The retry is a separate operation, so nothing on the failed row records
   * that it was already retried; a live button would file a sibling per press.
   */
  it("stops offering retry once the failure has been retried", () => {
    renderCard([
      operation({ id: "hro_2", state: "proving", retryOfOperationId: "hro_1" }),
      operation({ state: "failed", failureCode: "signer_failed", retryable: true }),
    ]);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  /**
   * An operation still in `indexing` offers a manual recheck so the operator
   * has recourse while the sweep and the 4-second poll are the only other path.
   * The recheck routes through `executeOperation` for `indexing` rows, since
   * the dedicated recheck endpoint only handles `failed` rows.
   */
  it("offers a recheck on an indexing operation via the execute path", async () => {
    const { onChanged } = renderCard([operation({ state: "indexing" })]);

    await userEvent.click(screen.getByRole("button", { name: "Check indexer" }));

    expect(mocks.executeRingsOperation).toHaveBeenCalledWith("hro_1");
    expect(mocks.recheckRingsOperation).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
});
