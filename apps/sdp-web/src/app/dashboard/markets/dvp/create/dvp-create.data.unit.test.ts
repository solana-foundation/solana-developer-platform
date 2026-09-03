/**
 * Loading the create form's options.
 *
 * This never throws: a form that renders with empty pickers beats a 500. The
 * cost of that choice is that "the request failed" and "you have none" become
 * the same empty list unless the error is carried out separately, which is
 * what most of these check.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchDvpCreateContext } from "./dvp-create.data";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function fail(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body };
}

const WALLET = {
  id: "cwlt_1",
  publicKey: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
  label: "Treasury",
};
const WALLET_WITH_BALANCES = {
  ...WALLET,
  balances: [
    {
      mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
      amount: "25000000000",
      decimals: 6,
      token: "ATD",
    },
    // The API falls back to the raw mint when it has no symbol. That is an
    // address, not a label, and repeating it would read as "25,000 ns7Y4h...".
    {
      mint: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
      amount: "50",
      decimals: 6,
      token: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    },
    // Incomplete rows cannot drive an amount conversion, so they are dropped
    // rather than defaulted to a scale nothing verified.
    { mint: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y", amount: "1", token: "X" },
  ],
};
const TOKEN = {
  id: "tok_1",
  mintAddress: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
  symbol: "TBOND",
  name: "Test Bond",
  decimals: 6,
};

/** Routes each call by path, so ordering assumptions cannot hide a bug. */
function request(responses: { wallets: unknown; tokens: unknown }) {
  return vi.fn(async (path: string) =>
    path.startsWith("/v1/wallets") ? responses.wallets : responses.tokens
  ) as never;
}

describe("fetchDvpCreateContext", () => {
  it("maps wallets and deployed tokens", async () => {
    const context = await fetchDvpCreateContext(
      request({ wallets: ok({ data: [WALLET] }), tokens: ok({ data: [TOKEN] }) })
    );

    expect(context.error).toBeNull();
    expect(context.wallets).toEqual([
      { id: "cwlt_1", address: WALLET.publicKey, label: "Treasury", balances: [] },
    ]);
    expect(context.tokens[0]).toMatchObject({
      mint: TOKEN.mintAddress,
      label: "TBOND",
      decimals: 6,
    });
  });

  it("accepts the wrapped wallets shape as well as the bare array", async () => {
    const context = await fetchDvpCreateContext(
      request({ wallets: ok({ data: { wallets: [WALLET] } }), tokens: ok({ data: [] }) })
    );

    expect(context.wallets).toHaveLength(1);
  });

  // A draft token has no mint, so nothing to put in escrow. Offering it would
  // be an invitation to a 400.
  it("drops a token that has no mint yet", async () => {
    const context = await fetchDvpCreateContext(
      request({
        wallets: ok({ data: [] }),
        tokens: ok({ data: [{ id: "tok_2", symbol: "DRAFT" }] }),
      })
    );

    expect(context.tokens).toEqual([]);
  });

  it("falls back to the name, then the mint, when a token has no symbol", async () => {
    const context = await fetchDvpCreateContext(
      request({
        wallets: ok({ data: [] }),
        tokens: ok({
          data: [{ mintAddress: "mint1", name: "Named" }, { mintAddress: "mint2" }],
        }),
      })
    );

    expect(context.tokens.map((token) => token.label)).toEqual(["Named", "mint2"]);
  });

  // THE case. Silently returning an empty list would send someone hunting for
  // assets they can see in Issuance.
  it("reports a failed token load rather than showing no tokens", async () => {
    const context = await fetchDvpCreateContext(
      request({
        wallets: ok({ data: [WALLET] }),
        tokens: fail(503, { error: { message: "Issuance unavailable." } }),
      })
    );

    expect(context.error).toBe("Issuance unavailable.");
    // The wallets that DID load are still offered.
    expect(context.wallets).toHaveLength(1);
  });

  it("reports a failed wallet load", async () => {
    const context = await fetchDvpCreateContext(
      request({ wallets: fail(500), tokens: ok({ data: [TOKEN] }) })
    );

    expect(context.error).toContain("500");
    expect(context.wallets).toEqual([]);
  });

  // Never throws: the page renders with empty pickers and an explanation.
  it("survives a transport failure", async () => {
    const context = await fetchDvpCreateContext(
      vi.fn(async () => {
        throw new Error("socket hang up");
      }) as never
    );

    expect(context.error).toBe("socket hang up");
    expect(context.wallets).toEqual([]);
    expect(context.tokens).toEqual([]);
  });

  // A decimals field that is absent is unknown, not zero. Treating it as zero
  // would make the amount field take a whole number for a 6-decimal mint.
  it("keeps unknown decimals null rather than defaulting to zero", async () => {
    const context = await fetchDvpCreateContext(
      request({ wallets: ok({ data: [] }), tokens: ok({ data: [{ mintAddress: "mint1" }] }) })
    );

    expect(context.tokens[0].decimals).toBeNull();
  });

  it("carries wallet balances, so a leg can show what it spends from", async () => {
    const context = await fetchDvpCreateContext(
      request({
        wallets: ok({ data: [WALLET_WITH_BALANCES] }),
        tokens: ok({ data: [TOKEN] }),
      })
    );

    expect(context.wallets[0].balances).toEqual([
      {
        mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
        amount: "25000000000",
        decimals: 6,
        symbol: "ATD",
      },
      {
        mint: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
        amount: "50",
        decimals: 6,
        symbol: null,
      },
    ]);
  });
});
