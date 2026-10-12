/**
 * When a request pays for a fresh reading of the chain.
 *
 * The sweep runs once a minute. That is right for a background job and wrong
 * for a page waiting on a counterparty's deposit — the one event this product
 * exists to show, and the one nothing announces. A closed trade's escrow can
 * also be re-created and paid into, so requests re-read eligible trades at a
 * status-specific cadence.
 */

import { runInClusterScope } from "@sdp/rpc/scope";
import { signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow, DvpTradeStatus } from "@/db/repositories";
import { buildDvpTradeRow } from "@/test/fixtures/dvp";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";

const recordObservation = vi.hoisted(() => vi.fn());
const readDvpTradeObservation = vi.hoisted(() => vi.fn());
const resolveDvpClose = vi.hoisted(() => vi.fn());

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
const NEVER_REREAD_STATUSES = ["create_failed"] as const satisfies readonly DvpTradeStatus[];
const CLOSED_REREAD_STATUSES = [
  "settled",
  "cancelled",
  "rejected",
  "closed_unknown",
] as const satisfies readonly DvpTradeStatus[];

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return buildDvpTradeRow({
    id: "dvp_observe",
    status: "partially_funded",
    observedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  });
}

function observeIfStale(row: DvpTradeRow, now: number) {
  return runInClusterScope({ projectId: row.projectId, environment: "sandbox" }, () =>
    observeDvpTradeIfStale(env, row, now)
  );
}

describe("observeDvpTradeIfStale", () => {
  const rpc = installClusterRpcStub();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.answer("getBlockHeight", 100);
    readDvpTradeObservation.mockResolvedValue({
      tradeAccountExists: true,
      legA: { exists: true, amount: 1n, frozen: false },
      legB: { exists: true, amount: 2n, frozen: false },
      blockHeight: 100n,
      clusterUnixTimestamp: 1_800_000_000n,
      closeResolution: null,
    });
    resolveDvpClose.mockResolvedValue({ kind: "absent" });
    recordObservation.mockResolvedValue(trade({ status: "funded" }));
  });

  it("re-reads an open trade whose last reading has aged out", async () => {
    const result = await observeIfStale(trade(), NOW);

    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("funded");
  });

  // The pairing with the page's poll interval is the whole cost control: most
  // polls must be answered from the row, not from the cluster.
  it("answers from the row when the reading is recent", async () => {
    await observeIfStale(trade({ observedAt: new Date(NOW - 1_000).toISOString() }), NOW);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
  });

  // A trade never observed is the strongest case for reading it. Parsing null
  // gives NaN, and NaN comparisons are false — so "recent enough" must not be
  // what an unparseable timestamp falls through to.
  it("reads a trade that has never been observed", async () => {
    await observeIfStale(trade({ observedAt: null }), NOW);

    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
  });

  // An expired trade's escrows still exist: a reclaim can drain one and a
  // deposit can land, and the counterparty's page has no other way to see it.
  it("re-reads an expired trade on the open cadence", async () => {
    await observeIfStale(
      trade({ status: "expired", observedAt: new Date(NOW - 5_000).toISOString() }),
      NOW
    );
    expect(readDvpTradeObservation).not.toHaveBeenCalled();

    await observeIfStale(
      trade({ status: "expired", observedAt: new Date(NOW - 11_000).toISOString() }),
      NOW
    );
    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
  });

  it.each(NEVER_REREAD_STATUSES)("never spends a chain read on a %s trade", async (status) => {
    await observeIfStale(trade({ status }), NOW);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
  });

  it.each(CLOSED_REREAD_STATUSES)(
    "answers a recently observed %s trade from the row",
    async (status) => {
      await observeIfStale(
        trade({ status, observedAt: new Date(NOW - 30_000).toISOString() }),
        NOW
      );

      expect(readDvpTradeObservation).not.toHaveBeenCalled();
    }
  );

  it.each(CLOSED_REREAD_STATUSES)(
    "re-reads a %s trade after the closed cadence elapses",
    async (status) => {
      await observeIfStale(
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
      clusterUnixTimestamp: 1_800_000_000n,
      closeResolution: null,
    });

    await observeIfStale(
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

    const result = await observeIfStale(trade(), NOW);

    expect(result.status).toBe("partially_funded");
  });

  it("rejects instead of answering from the row when the scope's cluster has no endpoint", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", "");

    await expect(observeIfStale(trade(), NOW)).rejects.toMatchObject({
      code: "RPC_NOT_CONFIGURED",
      details: { cluster: "devnet" },
    });
    expect(rpc.calls).toEqual([]);
    expect(readDvpTradeObservation).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
  });
});
