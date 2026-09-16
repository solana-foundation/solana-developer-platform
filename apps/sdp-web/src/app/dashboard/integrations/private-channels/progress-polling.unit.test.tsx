// @vitest-environment jsdom

import type { PrivateChannelDeposit, PrivateChannelWithdrawal } from "@sdp/types";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DepositProgress } from "./deposit/deposit-progress";
import { WithdrawProgress } from "./withdraw/withdraw-progress";

const mocks = vi.hoisted(() => ({ deposit: vi.fn(), withdrawal: vi.fn() }));
vi.mock("./deposit/actions", () => ({ fetchDepositAction: mocks.deposit }));
vi.mock("./withdraw/actions", () => ({ fetchWithdrawalAction: mocks.withdrawal }));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

function movement(id = "movement-1"): PrivateChannelDeposit & PrivateChannelWithdrawal {
  return {
    id,
    instanceId: "instance",
    organizationId: "org",
    projectId: "project",
    walletId: "wallet",
    depositor: "sender",
    recipient: "receiver",
    owner: "sender",
    destination: "receiver",
    mint: "mint",
    amount: "12",
    status: "submitted",
    signature: null,
    settlementRef: null,
    failureReason: null,
    context: {},
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

for (const kind of ["deposit", "withdrawal"] as const) {
  function progress(initial = movement()) {
    return (
      <SWRConfig
        value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryInterval: 1500 }}
      >
        <I18nProvider locale="en" messages={getMessages("en")}>
          {kind === "deposit" ? (
            <DepositProgress deposit={initial} onReset={() => {}} />
          ) : (
            <WithdrawProgress withdrawal={initial} onReset={() => {}} />
          )}
        </I18nProvider>
      </SWRConfig>
    );
  }

  describe(`${kind} progress polling`, () => {
    it("keeps only one status request active on a slow connection", async () => {
      const held = Promise.withResolvers<PrivateChannelDeposit & PrivateChannelWithdrawal>();
      mocks[kind].mockReturnValue(held.promise);
      render(progress());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mocks[kind]).toHaveBeenCalledTimes(1);
      await act(async () => {
        held.resolve({ ...movement(), status: "failed", failureReason: "Rejected by chain" });
      });
      expect(screen.getByText("Rejected by chain")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mocks[kind]).toHaveBeenCalledTimes(1);
    });

    it("does not poll a hidden page", async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      mocks[kind].mockResolvedValue(movement());
      render(progress());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mocks[kind]).not.toHaveBeenCalled();
    });

    it("recovers after repeated unavailable reads", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      mocks[kind]
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ ...movement(), status: "failed", failureReason: "Final status" });
      render(progress());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(screen.getByText("Final status")).toBeTruthy();
      expect(mocks[kind]).toHaveBeenCalledTimes(4);
    });

    it("does not apply an old movement response after the selection changes", async () => {
      const held = Promise.withResolvers<PrivateChannelDeposit & PrivateChannelWithdrawal>();
      mocks[kind].mockReturnValue(held.promise);
      const view = render(progress());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      view.rerender(progress(movement("movement-2")));
      await act(async () => {
        held.resolve({ ...movement(), status: "failed", failureReason: "Old movement failure" });
      });
      expect(screen.queryByText("Old movement failure")).toBeNull();
    });

    it("keeps the last known status after a transient read failure", async () => {
      mocks[kind]
        .mockResolvedValueOnce({ ...movement(), status: "confirmed" })
        .mockResolvedValue(null);
      render(progress());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      const label = kind === "deposit" ? "Confirmed" : "Burn confirmed";
      expect(screen.getByText(label)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText(label)).toBeTruthy();
    });
  });
}
