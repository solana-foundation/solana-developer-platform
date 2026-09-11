/**
 * When a request pays for a fresh reading of the chain.
 *
 * The sweep runs once a minute. That is right for a background job and wrong
 * for a page waiting on a counterparty's deposit — the one event this product
 * exists to show, and the one nothing announces. A closed trade's escrow can
 * also be re-created and paid into, so requests re-read eligible trades at a
 * status-specific cadence.
 */

import { signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow, DvpTradeStatus } from "@/db/repositories";
import { env } from "@/test/helpers/env";

const recordObservation = vi.hoisted(() => vi.fn());
const readDvpTradeObservation = vi.hoisted(() => vi.fn());
const getBlockHeight = vi.hoisted(() => vi.fn(() => ({ send: async () => 100n })));
const resolveDvpClose = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight }),
  confirmTransaction: vi.fn(),
}));
vi.mock("@/db/repositories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/repositories")>()),
  createDvpTradeRepository: () => ({ recordObservation }),
}));
vi.mock("./read-chain", () => ({ readDvpTradeObservation }));
vi.mock("./closing-transaction", () => ({ resolveDvpClose }));
vi.mock("./observe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./observe")>()),
  deriveDvpTradeState: () => ({ status: "funded" }),
}));

const { observeDvpTradeIfStale } = await import("./observe-now");

const NOW = Date.parse("2026-09-03T21:00:00.000Z");
const NEVER_REREAD_STATUSES = [
  "expired",
  "create_failed",
] as const satisfies readonly DvpTradeStatus[];
const CLOSED_REREAD_STATUSES = [
  "settled",
  "cancelled",
  "rejected",
  "closed_unknown",
] as const satisfies readonly DvpTradeStatus[];

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_observe",
    status: "partially_funded",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    closeResolutionAttempts: 0,
    closeResolutionAfter: null,
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    observedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  } as DvpTradeRow;
}

describe("observeDvpTradeIfStale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readDvpTradeObservation.mockResolvedValue({
      tradeAccountExists: true,
      legA: { exists: true, amount: 1n, frozen: false },
      legB: { exists: true, amount: 2n, frozen: false },
      blockHeight: 100n,
      closeResolution: null,
    });
    resolveDvpClose.mockResolvedValue({ kind: "absent" });
    recordObservation.mockResolvedValue(trade({ status: "funded" }));
  });

  it("re-reads an open trade whose last reading has aged out", async () => {
    const result = await observeDvpTradeIfStale(env, trade(), NOW);

    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("funded");
  });

  // The pairing with the page's poll interval is the whole cost control: most
  // polls must be answered from the row, not from the cluster.
  it("answers from the row when the reading is recent", async () => {
    await observeDvpTradeIfStale(
      env,
      trade({ observedAt: new Date(NOW - 1_000).toISOString() }),
      NOW
    );

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
  });

  // A trade never observed is the strongest case for reading it. Parsing null
  // gives NaN, and NaN comparisons are false — so "recent enough" must not be
  // what an unparseable timestamp falls through to.
  it("reads a trade that has never been observed", async () => {
    await observeDvpTradeIfStale(env, trade({ observedAt: null }), NOW);

    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
  });

  it.each(NEVER_REREAD_STATUSES)("never spends a chain read on a %s trade", async (status) => {
    await observeDvpTradeIfStale(env, trade({ status }), NOW);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
  });

  it.each(CLOSED_REREAD_STATUSES)(
    "answers a recently observed %s trade from the row",
    async (status) => {
      await observeDvpTradeIfStale(
        env,
        trade({ status, observedAt: new Date(NOW - 30_000).toISOString() }),
        NOW
      );

      expect(readDvpTradeObservation).not.toHaveBeenCalled();
    }
  );

  it.each(CLOSED_REREAD_STATUSES)(
    "re-reads a %s trade after the closed cadence elapses",
    async (status) => {
      await observeDvpTradeIfStale(
        env,
        trade({ status, observedAt: new Date(NOW - 90_000).toISOString() }),
        NOW
      );

      expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
    }
  );

  it("does not resolve a missing trade account when the close signature is already stored", async () => {
    readDvpTradeObservation.mockResolvedValue({
      tradeAccountExists: false,
      legA: { exists: false, tampered: false },
      legB: { exists: false, tampered: false },
      blockHeight: 100n,
      closeResolution: null,
    });

    await observeDvpTradeIfStale(
      env,
      trade({
        status: "settled",
        closeSignature: signature("1".repeat(64)),
        observedAt: new Date(NOW - 90_000).toISOString(),
      }),
      NOW
    );

    expect(resolveDvpClose).not.toHaveBeenCalled();
  });

  // A read that fails must not fail the request that triggered it: the caller
  // asked for a trade, and answering with the stored one is correct.
  it("falls back to the stored row when the chain cannot be read", async () => {
    readDvpTradeObservation.mockRejectedValue(new Error("rpc down"));

    const result = await observeDvpTradeIfStale(env, trade(), NOW);

    expect(result.status).toBe("partially_funded");
  });
});
