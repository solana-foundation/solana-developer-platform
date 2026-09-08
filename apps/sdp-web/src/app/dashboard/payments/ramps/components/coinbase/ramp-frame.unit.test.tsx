// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { PostCoinbaseRampEvent } from "./frame-events";
import { CoinbaseRampFrame } from "./ramp-frame";

const SRC = "https://pay.coinbase.com/v3/buy/input?sessionToken=abc";
const postEvent = vi.fn<PostCoinbaseRampEvent>().mockResolvedValue(undefined as never);

function renderFrame() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <CoinbaseRampFrame orderId="order_123" src={SRC} postEvent={postEvent} />
    </I18nProvider>
  );
}

function postFrameMessage(payload: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload), origin: new URL(SRC).origin })
    );
  });
}

describe("CoinbaseRampFrame", () => {
  afterEach(() => {
    cleanup();
    postEvent.mockClear();
  });

  it("renders the hosted flow as a full panel from the first paint", () => {
    renderFrame();

    const frame = screen.getByTitle("Coinbase onramp");
    expect(frame.className).toContain("h-96");
    expect(frame.className).not.toContain("h-12");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("allow")).toBe("payment");
  });

  it("keeps the panel through the embedded verification and upgrade steps", () => {
    renderFrame();

    postFrameMessage({ eventName: "onramp_api.verification_success" });
    postFrameMessage({ eventName: "onramp_api.upgrade_approved" });

    expect(screen.getByTitle("Coinbase onramp").className).toContain("h-96");
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("replaces the frame with Coinbase's message on session_error", () => {
    renderFrame();

    postFrameMessage({
      eventName: "onramp_api.session_error",
      data: { errorCode: "ERROR_CODE_LIMITS", errorMessage: "This purchase exceeds your limit." },
    });

    expect(screen.queryByTitle("Coinbase onramp")).toBeNull();
    expect(screen.getByText(/This purchase exceeds your limit\./)).toBeTruthy();
    expect(postEvent).toHaveBeenCalledWith(
      { kind: "errored", orderId: "order_123", reason: "This purchase exceeds your limit." },
      expect.any(Function)
    );
  });

  it("hides the frame once the payment is committed", () => {
    renderFrame();

    postFrameMessage({ eventName: "onramp_api.commit_success" });

    expect(screen.queryByTitle("Coinbase onramp")).toBeNull();
    expect(postEvent).toHaveBeenCalledWith(
      { kind: "committed", orderId: "order_123" },
      expect.any(Function)
    );
  });
});
