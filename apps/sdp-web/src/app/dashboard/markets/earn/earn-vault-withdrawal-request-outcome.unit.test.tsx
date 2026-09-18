// @vitest-environment jsdom

import type { EarnVaultWithdrawalRequestRecord } from "@sdp/types";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: { data: unknown } = { data: undefined };
  return {
    state,
    useSWR: vi.fn(() => ({ data: state.data })),
  };
});

vi.mock("swr", () => ({ default: mocks.useSWR }));

import { useEarnVaultWithdrawalRequestOutcome } from "./earn-program-data";

function request(
  status: EarnVaultWithdrawalRequestRecord["status"]
): EarnVaultWithdrawalRequestRecord {
  return {
    withdrawalRequestId: "request_1",
    positionId: "position_1",
    provider: "veda",
    providerReference: "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU",
    ownerAddress: "owner_1",
    requestAddress: "request_account_1",
    status,
    assetMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    shareMint: "So11111111111111111111111111111111111111112",
    shares: "5",
    quotedAssets: "4.9875",
    shareDecimals: 6,
    assetDecimals: 6,
    discountBps: 25,
    nonce: "1",
    creationTimestamp: "1789722000",
    maturityTimestamp: "1789722060",
    deadlineTimestamp: "1789722420",
    creationSignature: "request_signature",
    cancelSignature: null,
    closingSignature: null,
    assetsPaid: status === "fulfilled" ? "4.9875" : null,
    failureReason: null,
    fulfilledAt: status === "fulfilled" ? "2026-09-18T00:01:00.000Z" : null,
    cancelledAt: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:01:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.data = undefined;
});

afterEach(cleanup);

describe("useEarnVaultWithdrawalRequestOutcome", () => {
  it("reports a server-observed solver fulfillment exactly once", () => {
    const onSettled = vi.fn();
    const onUpdated = vi.fn();
    const pending = request("pending");
    const fulfilled = request("fulfilled");
    const view = renderHook(() =>
      useEarnVaultWithdrawalRequestOutcome("request_1", onSettled, onUpdated)
    );

    act(() => {
      mocks.state.data = pending;
      view.rerender();
    });
    expect(onUpdated).toHaveBeenLastCalledWith(pending);
    expect(onSettled).not.toHaveBeenCalled();

    act(() => {
      mocks.state.data = fulfilled;
      view.rerender();
    });
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(fulfilled);

    act(() => view.rerender());
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
