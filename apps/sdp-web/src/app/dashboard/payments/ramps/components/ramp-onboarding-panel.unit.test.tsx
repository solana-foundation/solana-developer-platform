// @vitest-environment jsdom

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { cancelRampTransfer } from "../../payments-workspace.data";
import { RampOnboardingPanel } from "./ramp-onboarding-panel";

vi.mock("../../payments-workspace.data", () => ({
  cancelRampTransfer: vi.fn(),
}));

const reservedRequirements: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "onramp",
  status: "funding_wallet_reserved",
  transfer: { id: "xfr_reserved_1", fiatAmount: "100", createdAt: "2026-09-18T00:00:00.000Z" },
};

const settlingRequirements: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "onramp",
  status: "funding_wallet_settling",
  transfer: { id: "xfr_settling_1", fiatAmount: "100", createdAt: "2026-09-18T00:00:00.000Z" },
};

function renderPanel(onboarding: CounterpartyRequirements, onRetry: () => void) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RampOnboardingPanel direction="onramp" onboarding={onboarding} onRetry={onRetry} />
    </I18nProvider>
  );
}

describe("RampOnboardingPanel reserved funding wallet", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the cancel action for a reserved transfer and cancels it by transfer id", async () => {
    const onRetry = vi.fn();
    vi.mocked(cancelRampTransfer).mockResolvedValue(undefined);
    renderPanel(reservedRequirements, onRetry);

    const button = screen.getByRole("button", { name: "Cancel and continue" });
    expect(button).not.toBeNull();
    fireEvent.click(button);

    expect(cancelRampTransfer).toHaveBeenCalledWith(
      { transferId: "xfr_reserved_1" },
      expect.anything()
    );
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it("does not render the cancel action for a settling funding wallet", () => {
    renderPanel(settlingRequirements, () => {});

    expect(screen.queryByRole("button", { name: "Cancel and continue" })).toBeNull();
  });

  it("surfaces a cancellation failure and lets the user retry", async () => {
    const onRetry = vi.fn();
    vi.mocked(cancelRampTransfer).mockRejectedValue(new Error("transferCancellationFailed"));
    renderPanel(reservedRequirements, onRetry);

    fireEvent.click(screen.getByRole("button", { name: "Cancel and continue" }));

    await waitFor(() => expect(screen.getByText("transferCancellationFailed")).not.toBeNull());
    expect(onRetry).not.toHaveBeenCalled();
  });
});
