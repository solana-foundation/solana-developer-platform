// @vitest-environment jsdom

import {
  PRIVATE_CHANNEL_DEPOSIT_TERMINAL_STATUSES,
  PRIVATE_CHANNEL_WITHDRAWAL_TERMINAL_STATUSES,
  type PrivateChannelDeposit,
  type PrivateChannelWithdrawal,
} from "@sdp/types/private-channels";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { EnglishI18n } from "@/test/i18n";
import {
  MovementReadsProbe,
  movementReadResponse,
  PRIVATE_CHANNELS_INSTANCE_READ,
  privateChannelMovementFixture,
  WALLET_SUMMARIES_READ,
} from "@/test/private-channels";
import { DepositProgress } from "./deposit/deposit-progress";
import { WithdrawProgress } from "./withdraw/withdraw-progress";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

type Movement = PrivateChannelDeposit & PrivateChannelWithdrawal;

function Reads({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ ...DASHBOARD_SWR_CONFIG, provider: () => new Map() }}>
      <EnglishI18n>{children}</EnglishI18n>
    </SWRConfig>
  );
}

function readPaths(fetchMock: Mock<typeof fetch>): string[] {
  return sentDashboardReads(fetchMock).map((read) => read.path);
}

function movementResponse(movement: Movement): Response {
  return Response.json({ data: movement });
}

const SUBMITTED = privateChannelMovementFixture({ id: "pcm_test_1", status: "submitted" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  {
    kind: "deposit",
    collection: "deposits",
    final: PRIVATE_CHANNEL_DEPOSIT_TERMINAL_STATUSES[0],
    confirmedLabel: "Confirmed",
  },
  {
    kind: "withdrawal",
    collection: "withdrawals",
    final: PRIVATE_CHANNEL_WITHDRAWAL_TERMINAL_STATUSES[0],
    confirmedLabel: "Burn confirmed",
  },
] as const)("$kind progress polling", ({ kind, collection, final, confirmedLabel }) => {
  const statusRead = `/api/dashboard/private-channels/${collection}/pcm_test_1`;

  function progress(movement: Movement) {
    return kind === "deposit" ? (
      <DepositProgress deposit={movement} onReset={vi.fn()} />
    ) : (
      <WithdrawProgress withdrawal={movement} onReset={vi.fn()} />
    );
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("keeps one status request in flight on a slow connection and stops once it is final", async () => {
    const held = Promise.withResolvers<Movement>();
    const fetchMock = stubDashboardFetch(async () => movementResponse(await held.promise));
    render(progress(SUBMITTED), { wrapper: Reads });

    await advance(6000);
    expect(readPaths(fetchMock)).toEqual([statusRead]);
    await act(async () => {
      held.resolve({ ...SUBMITTED, status: "failed", failureReason: "Rejected by chain" });
    });
    expect(screen.getByText("Rejected by chain")).toBeTruthy();
    await advance(6000);
    expect(readPaths(fetchMock)).toEqual([statusRead, statusRead]);
  });

  it("refreshes at the progress interval despite the dashboard cache defaults", async () => {
    const fetchMock = stubDashboardFetch(() => movementResponse(SUBMITTED));
    render(progress(SUBMITTED), { wrapper: Reads });

    await advance(4500);

    expect(readPaths(fetchMock)).toEqual([statusRead, statusRead, statusRead]);
  });

  it("does not poll a hidden page", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = stubDashboardFetch(() => movementResponse(SUBMITTED));
    render(progress(SUBMITTED), { wrapper: Reads });

    await advance(6000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers after repeated unavailable reads", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let statusReads = 0;
    stubDashboardFetch(() => {
      statusReads += 1;
      return statusReads <= 3
        ? dashboardErrorResponse(503, "Gateway unavailable")
        : movementResponse({ ...SUBMITTED, status: "failed", failureReason: "Final status" });
    });
    render(progress(SUBMITTED), { wrapper: Reads });

    await advance(60000);

    expect(screen.getByText("Final status")).toBeTruthy();
  });

  it("does not apply an old movement response after the selection changes", async () => {
    const held = Promise.withResolvers<Movement>();
    stubDashboardFetch(async ({ path }) =>
      path === statusRead
        ? movementResponse(await held.promise)
        : movementResponse({ ...SUBMITTED, id: "pcm_test_2" })
    );
    const view = render(progress(SUBMITTED), { wrapper: Reads });
    await advance(1500);

    view.rerender(progress({ ...SUBMITTED, id: "pcm_test_2" }));
    await act(async () => {
      held.resolve({ ...SUBMITTED, status: "failed", failureReason: "Old movement failure" });
    });

    expect(screen.queryByText("Old movement failure")).toBeNull();
  });

  it("keeps the last known status after a transient read failure", async () => {
    let statusReads = 0;
    stubDashboardFetch(() => {
      statusReads += 1;
      return statusReads === 1
        ? movementResponse({ ...SUBMITTED, status: "confirmed" })
        : dashboardErrorResponse(503, "Gateway unavailable");
    });
    render(progress(SUBMITTED), { wrapper: Reads });

    await advance(1500);
    expect(screen.getByText(confirmedLabel)).toBeTruthy();
    await advance(3000);
    expect(screen.getByText(confirmedLabel)).toBeTruthy();
  });

  it("re-reads Private Channels and custody wallet reads once the movement is final", async () => {
    let statusReads = 0;
    const fetchMock = stubDashboardFetch(({ path }) => {
      if (path !== statusRead) return movementReadResponse(path);
      statusReads += 1;
      return movementResponse({ ...SUBMITTED, status: statusReads === 1 ? "submitted" : final });
    });
    render(
      <>
        <MovementReadsProbe />
        {progress(SUBMITTED)}
      </>,
      { wrapper: Reads }
    );

    await advance(3000);

    expect(readPaths(fetchMock)).toEqual([
      PRIVATE_CHANNELS_INSTANCE_READ,
      WALLET_SUMMARIES_READ,
      statusRead,
      statusRead,
      PRIVATE_CHANNELS_INSTANCE_READ,
      WALLET_SUMMARIES_READ,
      statusRead,
    ]);
  });
});
