import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitRampSettled } from "./payment-events";

// The emit is fire-and-forget, so the assertion is on the dispatch call, not a return
// value. Parameters are declared so `mock.calls` carries the event shape.
const dispatchWorkflowEvent = vi.hoisted(() =>
  vi.fn(async (_env: unknown, _event: Record<string, unknown>) => 1)
);
vi.mock("./event-bus", () => ({ dispatchWorkflowEvent }));

type EmitContext = Parameters<typeof emitRampSettled>[0];

// A context built the way @hono/node-server builds one: no ExecutionContext. Hono's
// `c.executionCtx` getter THROWS ("This context has no ExecutionContext") rather than
// returning undefined, so an unguarded `c.executionCtx.waitUntil(...)` blows up the
// request. `app.request()` omits the execution context exactly like the Node adapter.
async function withNodeStyleContext(run: (c: EmitContext) => void) {
  const app = new Hono();
  let thrown: unknown = null;
  app.get("/", (c) => {
    try {
      run(c as unknown as EmitContext);
    } catch (error) {
      thrown = error;
    }
    return c.text("ok");
  });
  const response = await app.request("/");
  return { thrown, status: response.status };
}

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

describe("emitRampSettled on a runtime without an ExecutionContext (Node / Cloud Run)", () => {
  beforeEach(() => {
    dispatchWorkflowEvent.mockClear();
  });

  // Regression: the unguarded `c.executionCtx.waitUntil(...)` threw after
  // applyRampSettlementEvent had already committed the transfer as terminal, so the
  // webhook 500'd and the provider's retry returned early — losing the event forever.
  it("does not throw when the runtime has no ExecutionContext", async () => {
    const { thrown } = await withNodeStyleContext((c) => {
      emitRampSettled(c, input);
    });
    expect(thrown).toBeNull();
  });

  // The point of the fix is that the event still reaches the bus. A try/catch that
  // swallowed the failure would satisfy the test above while silently dropping every
  // onramp_settled/offramp_settled trigger, so assert the dispatch actually happened.
  it("still dispatches the settlement event", async () => {
    await withNodeStyleContext((c) => {
      emitRampSettled(c, input);
    });

    expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.type).toBe("onramp_settled");
    expect(event.eventKey).toBe("onramp_settled:ptr_1");
    expect(event.payload).toMatchObject({ transferId: "ptr_1", provider: "mural" });
  });

  it("maps an offramp direction to offramp_settled", async () => {
    await withNodeStyleContext((c) => {
      emitRampSettled(c, { ...input, direction: "offramp" });
    });

    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.type).toBe("offramp_settled");
    expect(event.eventKey).toBe("offramp_settled:ptr_1");
  });
});

describe("emitRampSettled on a runtime with an ExecutionContext (Workers)", () => {
  beforeEach(() => {
    dispatchWorkflowEvent.mockClear();
  });

  // Workers tear the isolate down at response time, so the dispatch must still be
  // handed to waitUntil to survive past the response.
  it("keeps the dispatch alive through waitUntil", async () => {
    const waitUntil = vi.fn();
    const c = {
      env: {},
      executionCtx: { waitUntil },
    } as unknown as EmitContext;

    emitRampSettled(c, input);

    expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
