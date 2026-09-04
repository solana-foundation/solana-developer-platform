// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { RingsOperationDetail } from "./helius-rings.data";
import { OperationDetailDrawer } from "./operation-detail-drawer";

const mocks = vi.hoisted(() => ({ fetchRingsOperationDetail: vi.fn() }));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  fetchRingsOperationDetail: mocks.fetchRingsOperationDetail,
}));

const RING_PROGRAM = "RingProgram1111111111111111111111111111111";

const DETAIL: RingsOperationDetail = {
  id: "hro_1",
  walletId: "hrw_1",
  opType: "withdraw",
  state: "completed",
  assetMint: "So11111111111111111111111111111111111111112",
  amountRaw: "1000000000",
  ringProgramId: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  failureCode: null,
  outerTxSignature: "4RfYCH8U",
  retryable: null,
  retryOfOperationId: null,
  failure: null,
  events: [],
};

function renderDrawer(detail: Partial<RingsOperationDetail> = {}, operationId = "hro_1") {
  mocks.fetchRingsOperationDetail.mockResolvedValue({ operation: { ...DETAIL, ...detail } });
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OperationDetailDrawer operationId={operationId} onClose={vi.fn()} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("OperationDetailDrawer", () => {
  it("reads nothing until an operation is selected", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <OperationDetailDrawer operationId={null} onClose={vi.fn()} />
      </I18nProvider>
    );

    expect(mocks.fetchRingsOperationDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the default ring when the operation pinned no ring", async () => {
    renderDrawer();

    expect(await screen.findByText("Default ring")).toBeTruthy();
    expect(screen.getByText("hro_1")).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
  });

  // A ring-bound operation prints the pinned program id: it is what the wire
  // gate matched, so it has to be readable straight from the record.
  it("prints the pinned ring program when the operation targeted one", async () => {
    renderDrawer({ ringProgramId: RING_PROGRAM });

    expect(await screen.findByText(RING_PROGRAM)).toBeTruthy();
    expect(screen.queryByText("Default ring")).toBeNull();
  });

  it("shows the failure code and message verbatim, and whether a retry can win", async () => {
    renderDrawer({
      state: "failed",
      failure: {
        code: "config_error",
        message: "the operation's ring has not completed bring-up",
        retryable: false,
      },
    });

    expect(await screen.findByText("config_error")).toBeTruthy();
    expect(screen.getByText(/has not completed bring-up/)).toBeTruthy();
    expect(screen.getByText(/Not retryable/)).toBeTruthy();
  });

  it("says a retryable failure can succeed", async () => {
    renderDrawer({
      state: "failed",
      failure: {
        code: "gateway_unavailable",
        message: "a Rings upstream is down",
        retryable: true,
      },
    });

    expect(await screen.findByText(/A retry can succeed/)).toBeTruthy();
  });

  it("names the operation this one replaced", async () => {
    renderDrawer({ retryOfOperationId: "hro_0" });

    expect(await screen.findByText("hro_0")).toBeTruthy();
  });

  it("says the timeline is empty rather than showing a bare heading", async () => {
    renderDrawer({ events: [] });

    expect(await screen.findByText("No events recorded.")).toBeTruthy();
  });

  it("labels a state transition by its target state and keeps unknown kinds visible", async () => {
    renderDrawer({
      events: [
        { kind: "operation.created", createdAt: "2026-08-26T12:00:00.000Z" },
        {
          kind: "state.transitioned",
          createdAt: "2026-08-26T12:00:01.000Z",
          payload: { to: "proving" },
        },
        // An upstream event this build has no copy for must still be visible.
        { kind: "operation.quarantined", createdAt: "2026-08-26T12:00:02.000Z" },
      ],
    });

    // Scoped to the timeline: "Created" is also the label of the created-at row.
    const timeline = within(await screen.findByRole("list"));
    expect(timeline.getByText("Created")).toBeTruthy();
    expect(timeline.getByText("Proving")).toBeTruthy();
    expect(timeline.getByText("operation.quarantined")).toBeTruthy();
  });

  // Two events of one kind at one timestamp are legal; the list must render
  // both rather than collapsing them onto a shared key.
  it("renders repeated events at the same instant", async () => {
    renderDrawer({
      events: [
        { kind: "policy.evaluated", createdAt: "2026-08-26T12:00:00.000Z" },
        { kind: "policy.evaluated", createdAt: "2026-08-26T12:00:00.000Z" },
      ],
    });

    expect(await screen.findAllByText("Policy checked")).toHaveLength(2);
  });

  it("surfaces a read failure instead of an empty drawer", async () => {
    mocks.fetchRingsOperationDetail.mockRejectedValue(new Error("Could not load Helius Rings"));
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <OperationDetailDrawer operationId="hro_1" onClose={vi.fn()} />
      </I18nProvider>
    );

    expect(await screen.findByText(/Could not load Helius Rings/)).toBeTruthy();
  });
});
