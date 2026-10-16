// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeposit, createWithdrawal, resumePendingIntent } from "./api";

const movement = {
  movementId: "movement",
  positionId: "position",
  provider: "kamino",
  providerReference: "vault",
  direction: "deposit",
  status: "submitted",
  signature: "sig",
  amount: "10",
  denomination: "usdc",
  tokenMint: "usdc",
  tokenAmount: "10",
  failureReason: null,
  createdAt: "2026-10-01T00:00:00Z",
  settledAt: null,
};
const intent = {
  kind: "deposit",
  transactionId: "build",
  signedTransaction: "signed",
  idempotencyKey: "key",
};
let chain: Promise<unknown>;
beforeEach(() => {
  localStorage.clear();
  chain = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, work: () => Promise<unknown>) => {
        const result = chain.then(work, work);
        chain = result.catch(() => undefined);
        return result;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("durable example intent", () => {
  it("recovers after a lost submit response and reload without rebuilding", async () => {
    const sent: unknown[] = [];
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/deposits")
        return Response.json({ data: { intent } });
      expect(localStorage.getItem("northstar:pending-intent:v1")).toContain(
        "signed"
      );
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) throw new Error("Lost response after broadcast");
      return Response.json({ data: { kind: "movement", movement } });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createDeposit("10")).rejects.toThrow("Lost response");
    vi.resetModules();
    const reloaded = await import("./api");
    await expect(reloaded.resumePendingIntent()).resolves.toMatchObject({
      kind: "movement",
    });
    expect(sent).toEqual([intent, intent]);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname === "/api/deposits")
    ).toHaveLength(1);
  });

  it("never submits when durable storage is unavailable", async () => {
    const fetch = vi.fn(async () => Response.json({ data: { intent } }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(createDeposit("10")).rejects.toThrow("Storage full");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains intent across malformed success and later authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ data: { intent } }))
        .mockResolvedValueOnce(
          Response.json({ data: { kind: "movement", movement: {} } })
        )
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: "Session expired" } },
            { status: 401 }
          )
        )
    );
    await expect(createDeposit("10")).rejects.toThrow();
    await expect(resumePendingIntent()).rejects.toThrow("Session expired");
    expect(localStorage.getItem("northstar:pending-intent:v1")).toContain(
      '"idempotencyKey":"key"'
    );
  });

  it.each(["deposit", "withdrawal"])(
    "allows three same-amount %s operations after acknowledged submits",
    async (kind) => {
      let builds = 0;
      const keys: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL, init?: RequestInit) => {
          if (url.pathname !== "/api/intents/submit") {
            builds += 1;
            return Response.json({
              data: {
                intent: {
                  ...intent,
                  kind,
                  transactionId: `build-${builds}`,
                  idempotencyKey: `key-${builds}`,
                },
              },
            });
          }
          keys.push(JSON.parse(String(init?.body)).idempotencyKey);
          return Response.json({
            data: {
              kind: "movement",
              movement: {
                ...movement,
                direction: kind,
                movementId: `movement-${builds}`,
              },
            },
          });
        })
      );
      for (let i = 0; i < 3; i += 1) {
        if (kind === "deposit") await createDeposit("10");
        else await createWithdrawal({ amount: "10", route: "direct" });
      }
      expect(builds).toBe(3);
      expect(new Set(keys).size).toBe(3);
    }
  );
});
