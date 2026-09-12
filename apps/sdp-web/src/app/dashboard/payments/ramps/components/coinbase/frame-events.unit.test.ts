import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCoinbaseFrameEvent, type PostCoinbaseRampEvent } from "./frame-events";

const t = (key: string) => key;
const ORDER_ID = "order_123";
const postEvent = vi.fn<PostCoinbaseRampEvent>();

function frameMessage(eventName: string, data?: Record<string, string>): string {
  return JSON.stringify(data ? { eventName, data } : { eventName });
}

function handle(raw: unknown) {
  return handleCoinbaseFrameEvent(ORDER_ID, raw, t, { postEvent });
}

describe("handleCoinbaseFrameEvent", () => {
  beforeEach(() => {
    postEvent.mockReset();
    postEvent.mockResolvedValue(undefined as never);
  });

  it.each([
    "onramp_api.verification_success",
    "onramp_api.upgrade_submit_success",
    "onramp_api.upgrade_approved",
  ])("parses the embedded progress event %s without reporting it", (eventName) => {
    const event = handle(frameMessage(eventName));

    expect(event?.eventName).toBe(eventName);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("reports session_error as an errored transfer with Coinbase's message", () => {
    const event = handle(
      frameMessage("onramp_api.session_error", {
        errorCode: "ERROR_CODE_VERIFICATION_FAILED",
        errorMessage: "We could not verify your phone number.",
      })
    );

    expect(event?.eventName).toBe("onramp_api.session_error");
    expect(postEvent).toHaveBeenCalledWith(
      { kind: "errored", orderId: ORDER_ID, reason: "We could not verify your phone number." },
      t
    );
  });

  it("falls back to the error code when Coinbase sends an empty message", () => {
    handle(
      frameMessage("onramp_api.session_error", {
        errorCode: "ERROR_CODE_SESSION_EXPIRED",
        errorMessage: "   ",
      })
    );

    expect(postEvent).toHaveBeenCalledWith(
      { kind: "errored", orderId: ORDER_ID, reason: "ERROR_CODE_SESSION_EXPIRED" },
      t
    );
  });

  it("rejects a session_error without the error payload", () => {
    expect(handle(frameMessage("onramp_api.session_error"))).toBeNull();
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("still reports commit_success as committed", () => {
    handle(frameMessage("onramp_api.commit_success"));

    expect(postEvent).toHaveBeenCalledWith({ kind: "committed", orderId: ORDER_ID }, t);
  });

  it("returns null for foreign or unknown messages", () => {
    expect(handle({ eventName: "onramp_api.load_success" })).toBeNull();
    expect(handle("not json")).toBeNull();
    expect(handle(frameMessage("onramp_api.future_event"))).toBeNull();
    expect(postEvent).not.toHaveBeenCalled();
  });
});
