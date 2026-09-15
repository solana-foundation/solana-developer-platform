/**
 * The leg action's side of the close exclusion (PRO-1973).
 *
 * A funding or reclaim has already locked its leg when it asks this. The only
 * question left is whether a settle or cancel locked the trade first and can
 * still land.
 */

import { DVP_LEG_REFUSAL } from "@sdp/types";
import { signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpCloseClaim } from "@/db/repositories";
import { buildDvpTradeRow } from "@/test/fixtures/dvp";
import { env } from "@/test/helpers/env";

const getByIdAsParty = vi.hoisted(() => vi.fn());
const getBlockHeight = vi.hoisted(() => vi.fn());

vi.mock("@/db/repositories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/repositories")>()),
  createDvpTradeRepository: () => ({ getByIdAsParty }),
}));

const { assertTradeNotClosing, isLiveCloseClaim } = await import("./close-exclusion");

const rpc = { getBlockHeight: () => ({ send: getBlockHeight }) } as never;

const CLAIM: DvpCloseClaim = {
  action: "settle",
  signature: signature("1".repeat(64)),
  expiryHeight: "500",
};

describe("isLiveCloseClaim", () => {
  it("is live through its last valid height and not after", () => {
    expect(isLiveCloseClaim(CLAIM, 499n)).toBe(true);
    expect(isLiveCloseClaim(CLAIM, 500n)).toBe(true);
    expect(isLiveCloseClaim(CLAIM, 501n)).toBe(false);
  });

  it("is never live without a claim", () => {
    expect(isLiveCloseClaim(null, 0n)).toBe(false);
  });
});

describe("assertTradeNotClosing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBlockHeight.mockResolvedValue(500n);
  });

  it("lets the leg action through when no close holds the trade, without reading the chain", async () => {
    getByIdAsParty.mockResolvedValue(buildDvpTradeRow({ id: "dvp_x", closeClaim: null }));

    await expect(assertTradeNotClosing(env, rpc, "dvp_x")).resolves.toBeUndefined();
    expect(getBlockHeight).not.toHaveBeenCalled();
  });

  it("refuses while a close can still land", async () => {
    getByIdAsParty.mockResolvedValue(buildDvpTradeRow({ id: "dvp_x", closeClaim: CLAIM }));

    await expect(assertTradeNotClosing(env, rpc, "dvp_x")).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: DVP_LEG_REFUSAL.tradeClosing },
    });
  });

  // The reconciler has not swept it yet, but past its height the close either
  // landed, and the chain refuses the leg action itself, or never will.
  it("lets the leg action through once the close lock can no longer land", async () => {
    getByIdAsParty.mockResolvedValue(buildDvpTradeRow({ id: "dvp_x", closeClaim: CLAIM }));
    getBlockHeight.mockResolvedValue(501n);

    await expect(assertTradeNotClosing(env, rpc, "dvp_x")).resolves.toBeUndefined();
  });

  it("fails loudly when the trade can no longer be read", async () => {
    getByIdAsParty.mockResolvedValue(null);

    await expect(assertTradeNotClosing(env, rpc, "dvp_x")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
