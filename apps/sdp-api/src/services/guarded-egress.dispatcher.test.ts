import { describe, expect, it, vi } from "vitest";

// The dispatcher resolves every name through the shared `guardedLookup`, so the
// mocked DNS answer decides what a connect would dial — the same hook the
// rebinding test pins for `guardedFetch`, exercised through undici here.
const answers: string[][] = [];
vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: (
    hostname: string,
    _options: unknown,
    callback: (error: null, addresses: { address: string; family: number }[]) => void
  ) => {
    seenNames.push(hostname);
    const next = answers.shift() ?? [];
    callback(
      null,
      next.map((address) => ({ address, family: 4 }))
    );
  },
}));

const seenNames: string[] = [];

import type { Dispatcher } from "undici";
import { createGuardedDispatcher, EgressBlockedError } from "@/services/guarded-egress";

interface DispatchOutcome {
  error?: Error;
  connected?: true;
}

function dispatchAndWait(
  dispatcher: Dispatcher,
  options: { origin: string | URL; path?: string; method?: string }
): Promise<DispatchOutcome> {
  return new Promise((resolve) => {
    try {
      const ok = dispatcher.dispatch(
        { origin: options.origin, path: options.path ?? "/", method: options.method ?? "GET" },
        {
          onConnect: () => resolve({ connected: true }),
          onError: (error: Error) => resolve({ error }),
        }
      );
      if (!ok) resolve({ error: new Error("dispatch was not queued") });
    } catch (error) {
      resolve({ error: error as Error });
    }
  });
}

describe("createGuardedDispatcher", () => {
  it("is one instance for the process, so gateway resolution cannot pool per request", () => {
    expect(createGuardedDispatcher()).toBe(createGuardedDispatcher());
  });

  it("refuses a plaintext origin before any socket exists", async () => {
    const outcome = await dispatchAndWait(createGuardedDispatcher(), {
      origin: "http://rpc.tenant.example",
    });
    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect(seenNames).toEqual([]);
  });

  it("refuses a host written as a blocked address literal, which never reaches the lookup", async () => {
    const outcome = await dispatchAndWait(createGuardedDispatcher(), {
      origin: "https://169.254.169.254",
    });
    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect(seenNames).toEqual([]);
  });

  it("refuses a dispatch without an origin rather than dialing something unexamined", async () => {
    const dispatcher = createGuardedDispatcher();
    const outcome = await dispatchAndWait(dispatcher, {
      origin: undefined as unknown as URL,
    });
    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
    expect(seenNames).toEqual([]);
  });

  it("resolves a name through the guard at connect time, so a rebound record cannot be dialed", async () => {
    answers.push(["169.254.169.254"]);

    const outcome = await dispatchAndWait(createGuardedDispatcher(), {
      origin: "https://rpc.tenant.example",
    });

    expect(seenNames).toEqual(["rpc.tenant.example"]);
    expect(outcome.error).toBeInstanceOf(EgressBlockedError);
  });
});
