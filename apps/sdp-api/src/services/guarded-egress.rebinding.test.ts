import { describe, expect, it, vi } from "vitest";

// The DNS answer changes BETWEEN calls: public at validation time, the
// metadata address on the next connect — the classic rebinding shape. The
// guard resolves through this hook on every connect, so the flipped record
// must be refused at use time no matter what earlier resolutions said.
const answers: string[][] = [];
vi.mock("node:dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns")>()),
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (error: null, addresses: { address: string; family: number }[]) => void
  ) => {
    const next = answers.shift() ?? [];
    callback(
      null,
      next.map((address) => ({ address, family: 4 }))
    );
  },
}));

import { EgressBlockedError, guardedLookup } from "@/services/guarded-egress";

function lookupOnce(): Promise<{ error: Error | null; address: string }> {
  return new Promise((resolve) => {
    guardedLookup("rpc.tenant.example", { family: 0 }, (error, address) =>
      resolve({ error: error as Error | null, address: address as string })
    );
  });
}

describe("guardedLookup under DNS rebinding", () => {
  it("re-resolves on every connect, so a record that flips inward is refused at use time", async () => {
    answers.push(["8.8.8.8"], ["169.254.169.254"]);

    const first = await lookupOnce();
    expect(first.error).toBeNull();
    expect(first.address).toBe("8.8.8.8");

    // Same name, new connect: the rebound record must not reach the socket.
    const second = await lookupOnce();
    expect(second.error).toBeInstanceOf(EgressBlockedError);
  });

  it("drops only the blocked addresses when a name resolves to a mixed set", async () => {
    answers.push(["10.0.0.5", "1.1.1.1"]);

    const result = await lookupOnce();
    expect(result.error).toBeNull();
    expect(result.address).toBe("1.1.1.1");
  });
});
