import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { emitRampSettled } from "./payment-events";

// The emit is fire-and-forget, so the assertion is on the dispatch call, not a return
// value. Parameters are declared so `mock.calls` carries the event shape.
const dispatchWorkflowEvent = vi.hoisted(() =>
  vi.fn(async (_env: unknown, _event: Record<string, unknown>) => 1)
);
vi.mock("./event-bus", () => ({ dispatchWorkflowEvent }));

const env = {} as Env;

const input = {
  organizationId: "org_1",
  projectId: "proj_1",
  direction: "onramp" as const,
  transferId: "ptr_1",
  provider: "mural",
  counterpartyId: "cp_1",
  amount: "100",
  fiatCurrency: "USD",
  cryptoToken: "USDC",
};

describe("emitRampSettled", () => {
  beforeEach(() => {
    dispatchWorkflowEvent.mockClear();
  });

  // A try/catch that swallowed a dispatch failure would silently drop every
  // onramp_settled/offramp_settled trigger, so assert the dispatch actually happens.
  it("dispatches the settlement event", () => {
    emitRampSettled(env, input);

    expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.type).toBe("onramp_settled");
    expect(event.eventKey).toBe("onramp_settled:ptr_1");
    expect(event.payload).toMatchObject({ transferId: "ptr_1", provider: "mural" });
  });

  it("maps an offramp direction to offramp_settled", () => {
    emitRampSettled(env, { ...input, direction: "offramp" });

    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.type).toBe("offramp_settled");
    expect(event.eventKey).toBe("offramp_settled:ptr_1");
  });

  it("does not throw when the dispatch rejects", async () => {
    dispatchWorkflowEvent.mockRejectedValueOnce(new Error("bus down"));

    expect(() => emitRampSettled(env, input)).not.toThrow();
    await vi.waitFor(() => expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1));
  });
});
