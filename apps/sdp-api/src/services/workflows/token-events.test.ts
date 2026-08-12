import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitTokenOperationCompleted } from "./token-events";

// The emit is fire-and-forget, so the assertion is on the dispatch call, not a return
// value. Parameters are declared so `mock.calls` carries the event shape.
const dispatchWorkflowEvent = vi.hoisted(() =>
  vi.fn(async (_env: unknown, _event: Record<string, unknown>) => 1)
);
vi.mock("./event-bus", () => ({ dispatchWorkflowEvent }));

type EmitContext = Parameters<typeof emitTokenOperationCompleted>[0];

// A context built the way @hono/node-server builds one: no ExecutionContext. Hono's
// `c.executionCtx` getter THROWS rather than returning undefined, and JS evaluates the
// callee `c.executionCtx.waitUntil` ahead of its arguments — so an unguarded call loses
// the dispatch entirely. `app.request()` omits the execution context like the Node adapter.
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
  tokenId: "tok_1",
  operation: "freeze",
  signature: "5xSig111111111111111111111111111111111111111",
  slot: 1234,
};

describe("emitTokenOperationCompleted on a runtime without an ExecutionContext (Node / Cloud Run)", () => {
  beforeEach(() => {
    dispatchWorkflowEvent.mockClear();
  });

  it("does not throw when the runtime has no ExecutionContext", async () => {
    const { thrown } = await withNodeStyleContext((c) => {
      emitTokenOperationCompleted(c, input);
    });
    expect(thrown).toBeNull();
  });

  // The regression. The unguarded `c.executionCtx.waitUntil(...)` threw before the
  // dispatch argument was ever evaluated, so the outer catch logged "emit failed" and the
  // event was lost — silently dropping every token_operation_completed rule in production.
  // The not-throwing test above passes either way, so this is the one that matters.
  it("still dispatches the completion event", async () => {
    await withNodeStyleContext((c) => {
      emitTokenOperationCompleted(c, input);
    });

    expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.type).toBe("token_operation_completed");
    expect(event.eventKey).toBe(`token_operation_completed:${input.signature}`);
    expect(event.tokenId).toBe("tok_1");
    expect(event.payload).toMatchObject({ operation: "freeze", signature: input.signature });
  });

  // Without a signature the key falls back to the platform transaction id, which still has
  // to survive the Node path.
  it("dispatches with the transaction-id fallback key when there is no signature", async () => {
    await withNodeStyleContext((c) => {
      emitTokenOperationCompleted(c, {
        ...input,
        signature: null,
        transactionId: "txn_1",
      });
    });

    const [, event] = dispatchWorkflowEvent.mock.calls[0];
    expect(event.eventKey).toBe("token_operation_completed:txn_1");
  });
});

describe("emitTokenOperationCompleted on a runtime with an ExecutionContext (Workers)", () => {
  beforeEach(() => {
    dispatchWorkflowEvent.mockClear();
  });

  // Workers tear the isolate down at response time, so the dispatch must still be handed
  // to waitUntil to survive past the response.
  it("keeps the dispatch alive through waitUntil", async () => {
    const waitUntil = vi.fn();
    const c = { env: {}, executionCtx: { waitUntil } } as unknown as EmitContext;

    emitTokenOperationCompleted(c, input);

    expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
