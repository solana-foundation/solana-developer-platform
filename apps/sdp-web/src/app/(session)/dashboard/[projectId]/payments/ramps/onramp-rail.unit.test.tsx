// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTranslations } from "@/i18n/provider";
import { EnglishI18n } from "@/test/i18n";
import { type OnrampFrameWizard, onrampFrameState } from "./onramp-rail";

function englishT() {
  return renderHook(() => useTranslations(), { wrapper: EnglishI18n }).result.current;
}

/** A sandbox bank-wire deposit on its provider step, quoted and still awaiting its pay-in. */
function awaitingSimulation(overrides: Partial<OnrampFrameWizard> = {}): OnrampFrameWizard {
  return {
    canProceed: true,
    currentStepId: "PROVIDER",
    handleSecondary: vi.fn(),
    hostedQuoteLoading: false,
    isCanceling: false,
    onTransactionStage: true,
    onboarding: null,
    quoteSimulationLoading: false,
    quoteSimulationSucceeded: false,
    simulateAvailable: true,
    walletsLoading: false,
    fields: { provider: "hercle" },
    quote: { deliveryMode: "manual_instructions" },
    transferStatus: { status: "awaiting_payment" },
    ...overrides,
  };
}

describe("onrampFrameState", () => {
  it("offers both the simulated pay-in and Cancel deposit while neither runs", () => {
    const frame = onrampFrameState(awaitingSimulation(), undefined, englishT());

    expect(frame.onCancel).toBeDefined();
    expect(frame.cancelDisabled).toBe(false);
    expect(frame.primaryDisabled).toBe(false);
  });

  it("holds Cancel deposit while the simulated pay-in runs", () => {
    const frame = onrampFrameState(
      awaitingSimulation({ quoteSimulationLoading: true }),
      undefined,
      englishT()
    );

    expect(frame.onCancel).toBeDefined();
    expect(frame.cancelDisabled).toBe(true);
    expect(frame.primaryLoading).toBe(true);
  });

  it("holds the simulated pay-in while the cancel runs", () => {
    const frame = onrampFrameState(
      awaitingSimulation({ isCanceling: true }),
      undefined,
      englishT()
    );

    expect(frame.primaryDisabled).toBe(true);
    expect(frame.cancelDisabled).toBe(true);
  });
});
