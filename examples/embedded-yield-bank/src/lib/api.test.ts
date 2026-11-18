// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumePendingIntent } from "./api";

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
    const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(localStorage.getItem("northstar:pending-intent:v1")).toContain(
        "signed"
      );
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) throw new Error("Lost response after broadcast");
      return Response.json({ data: { kind: "movement", movement } });
    });
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem(
      "northstar:pending-intent:v1",
      JSON.stringify({ fingerprint: "saved-before-upgrade", intent })
    );
    await expect(resumePendingIntent()).rejects.toThrow("Lost response");
    vi.resetModules();
    const reloaded = await import("./api");
    await expect(reloaded.resumePendingIntent()).resolves.toMatchObject({
      kind: "movement",
    });
    expect(sent).toEqual([intent, intent]);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname === "/api/deposits")
    ).toHaveLength(0);
  });

  it("retains intent across malformed success and later authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
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
    localStorage.setItem(
      "northstar:pending-intent:v1",
      JSON.stringify({ fingerprint: "saved-before-upgrade", intent })
    );
    await expect(resumePendingIntent()).rejects.toThrow();
    await expect(resumePendingIntent()).rejects.toThrow("Session expired");
    expect(localStorage.getItem("northstar:pending-intent:v1")).toContain(
      '"idempotencyKey":"key"'
    );
  });
});
