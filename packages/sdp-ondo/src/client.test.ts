import type { EarnRuntimeContext } from "@sdp/earn/types";
import { wellKnownMint } from "@sdp/types";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ONDO_SWAP_COMPUTE_UNIT_LIMIT, OndoVaultDirectClient } from "./client";
import { SdpOndoError } from "./errors";
import type { OndoSwapLeg, OndoSwapPort } from "./types";

/**
 * Offline harness: the swap port is a stub and `globalThis.fetch` (the token
 * account read) is stubbed per test. Package tests touch no network — the
 * env-gated smoke test is the only exception, per the repo rule.
 */

const MAINNET = ONDO_DEPLOYMENTS["mainnet-beta"];
if (!MAINNET) throw new Error("test premise: mainnet deployment filled in");
const USDY = MAINNET.usdyMint;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const OWNER = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const CTX: EarnRuntimeContext = { env: {}, environment: "production" };

function leg(minOutAmount: string, quotedAmount = minOutAmount): OndoSwapLeg {
  return {
    instructions: [
      {
        programAddress: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [{ address: OWNER, role: 3 }],
        data: "AA==",
      },
    ],
    lookupTableAddresses: ["9jQqxu5N6bV1qkh1Yv5F6zSMDNFCV2eqRV8HqvcHhk9V"],
    quotedAmount,
    minOutAmount,
    priceImpactPct: "0.0001",
    routeLabels: ["Whirlpool"],
  };
}

function makeClient(port: Partial<OndoSwapPort>) {
  const swapPort: OndoSwapPort = {
    quoteSwap: port.quoteSwap ?? (async () => ({ outAmount: "0", priceImpactPct: "0" })),
    buildSwapLeg: port.buildSwapLeg ?? (async () => leg("0")),
  };
  return new OndoVaultDirectClient(
    async () => "https://rpc.test",
    (_label, operation) => operation(() => {}),
    () => swapPort
  );
}

function stubTokenAccounts(amounts: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: amounts.map((amount) => ({
            account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
          })),
        },
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildVaultDeposit", () => {
  it("refuses a deposit without a slippage floor", async () => {
    const client = makeClient({});
    await expect(
      client.buildVaultDeposit(CTX, { providerReference: USDY, owner: OWNER, amount: "100" })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("refuses a foreign rent payer", async () => {
    const client = makeClient({});
    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: USDY,
        owner: OWNER,
        amount: "100",
        minSharesOut: "87",
        rentPayer: USDC,
      })
    ).rejects.toMatchObject({ code: "DEPOSIT_REFUSED" });
  });

  it("refuses a reference that is not the USDY instrument", async () => {
    const client = makeClient({});
    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: USDC,
        owner: OWNER,
        amount: "100",
        minSharesOut: "87",
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VAULT" });
  });

  it("refuses sub-atom precision instead of rounding", async () => {
    const client = makeClient({});
    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: USDY,
        owner: OWNER,
        amount: "100.1234567",
        minSharesOut: "87",
      })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("refuses when the market pays less than the requested floor", async () => {
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "86", priceImpactPct: "0" }),
    });
    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: USDY,
        owner: OWNER,
        amount: "100",
        minSharesOut: "87",
      })
    ).rejects.toMatchObject({ code: "DEPOSIT_REFUSED" });
  });

  it("derives the tolerance from the quote and proves the leg covers the floor", async () => {
    stubTokenAccounts([]); // no USDY account yet: this deposit creates it
    const buildSwapLeg = vi.fn(async (request: { slippageBps: number }) => {
      // ⌊(87.5 − 87)/87.5 × 10⁴⌋ = 57
      expect(request.slippageBps).toBe(57);
      return leg("87.1", "87.5");
    });
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "87.5", priceImpactPct: "0" }),
      buildSwapLeg,
    });

    const plan = await client.buildVaultDeposit(CTX, {
      providerReference: USDY,
      owner: OWNER,
      amount: "100.50",
      minSharesOut: "87.0",
    });

    expect(plan.cluster).toBe("mainnet-beta");
    // Locally-built compute-unit limit first, then the admitted leg.
    expect(plan.instructions[0]?.programAddress).toBe(
      "ComputeBudget111111111111111111111111111111"
    );
    const cuData = Buffer.from(plan.instructions[0]?.data ?? "", "base64");
    expect(cuData.readUInt32LE(1)).toBe(ONDO_SWAP_COMPUTE_UNIT_LIMIT);
    expect(plan.instructions).toHaveLength(2);
    expect(plan.lookupTables).toEqual(["9jQqxu5N6bV1qkh1Yv5F6zSMDNFCV2eqRV8HqvcHhk9V"]);
    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: USDY });
    // Canonicalized to what the swap encodes: trailing zeroes dropped.
    expect(plan.accepted).toEqual({ amount: "100.5", minSharesOut: "87" });
    expect(plan.createsShareAccount).toBe(true);
  });

  it("retries once at zero tolerance when the built floor lands short", async () => {
    stubTokenAccounts(["1"]);
    const buildSwapLeg = vi
      .fn<OndoSwapPort["buildSwapLeg"]>()
      .mockResolvedValueOnce(leg("86.9"))
      .mockResolvedValueOnce(leg("87.2"));
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "87.5", priceImpactPct: "0" }),
      buildSwapLeg,
    });

    const plan = await client.buildVaultDeposit(CTX, {
      providerReference: USDY,
      owner: OWNER,
      amount: "100",
      minSharesOut: "87",
    });

    expect(buildSwapLeg).toHaveBeenCalledTimes(2);
    expect(buildSwapLeg.mock.calls[1]?.[0]?.slippageBps).toBe(0);
    expect(plan.createsShareAccount).toBe(false);
  });

  it("refuses when even zero tolerance cannot reach the floor", async () => {
    stubTokenAccounts(["1"]);
    const buildSwapLeg = vi.fn<OndoSwapPort["buildSwapLeg"]>().mockResolvedValue(leg("86.9"));
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "87.5", priceImpactPct: "0" }),
      buildSwapLeg,
    });

    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: USDY,
        owner: OWNER,
        amount: "100",
        minSharesOut: "87",
      })
    ).rejects.toMatchObject({ code: "DEPOSIT_REFUSED" });
    expect(buildSwapLeg).toHaveBeenCalledTimes(2);
  });
});

describe("buildVaultWithdrawal", () => {
  it("refuses a withdrawal without a slippage floor", async () => {
    const client = makeClient({});
    await expect(
      client.buildVaultWithdrawal(CTX, { providerReference: USDY, owner: OWNER, shares: "50" })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("builds the reverse swap and reports share-scale accepted amounts", async () => {
    const buildSwapLeg = vi.fn(async (request: { inputMint: string; outputMint: string }) => {
      expect(request.inputMint).toBe(USDY);
      expect(request.outputMint).toBe(USDC);
      return leg("57.05", "57.1");
    });
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "57.1", priceImpactPct: "0" }),
      buildSwapLeg,
    });

    const plan = await client.buildVaultWithdrawal(CTX, {
      providerReference: USDY,
      owner: OWNER,
      shares: "50",
      minAmountOut: "57",
    });

    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: USDY });
    expect(plan.accepted).toEqual({ shares: "50", minAmountOut: "57" });
    expect(plan.createsShareAccount).toBeUndefined();
  });
});

describe("quotes", () => {
  it("quotes a deposit in shares and a withdrawal in assets", async () => {
    const quoteSwap = vi.fn(
      async (request: {
        inputMint: string;
      }): Promise<{ outAmount: string; priceImpactPct: string }> =>
        request.inputMint === USDC
          ? { outAmount: "87.3", priceImpactPct: "0" }
          : { outAmount: "114.5", priceImpactPct: "0" }
    );
    const client = makeClient({ quoteSwap });

    const deposit = await client.quoteVaultDeposit(CTX, {
      providerReference: USDY,
      amount: "100",
    });
    expect(deposit).toEqual({ sharesOut: "87.3", shareDecimals: 6, blockingIssues: [] });

    const exit = await client.quoteVaultWithdrawal(CTX, {
      providerReference: USDY,
      shares: "100",
    });
    expect(exit).toEqual({ assetsOut: "114.5", assetDecimals: 6, blockingIssues: [] });
  });
});

describe("readVaultPositions", () => {
  it("sums exact raw balances and values them through the exit quote", async () => {
    stubTokenAccounts(["1000000", "2500000"]);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "4.006", priceImpactPct: "0" }),
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [],
    });

    expect(positions).toEqual([
      {
        providerReference: USDY,
        owner: OWNER,
        cluster: "mainnet-beta",
        shares: "3.5",
        withdrawableShares: "3.5",
        tokenValue: "4.006",
        tokenMint: USDC,
        shareMint: USDY,
      },
    ]);
  });

  it("keeps the holding when the valuation fails", async () => {
    stubTokenAccounts(["1000000"]);
    const client = makeClient({
      quoteSwap: async () => {
        throw new Error("quote outage");
      },
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares).toBe("1");
    expect(positions[0]?.tokenValue).toBeUndefined();
  });

  it("drops zero balances from a full-shelf read but reports them when asked", async () => {
    stubTokenAccounts([]);
    const client = makeClient({});

    expect(await client.readVaultPositions(CTX, { owner: OWNER, providerReferences: [] })).toEqual(
      []
    );

    const explicit = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });
    expect(explicit[0]?.shares).toBe("0");
    expect(explicit[0]?.tokenValue).toBe("0");
  });

  it("refuses a balance the RPC cannot state exactly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { value: [{ account: { data: { parsed: { info: { tokenAmount: {} } } } } }] },
        })
      )
    );
    const client = makeClient({});
    await expect(
      client.readVaultPositions(CTX, { owner: OWNER, providerReferences: [USDY] })
    ).rejects.toMatchObject({ code: "POSITION_UNREADABLE" });
  });

  it("fails closed on a sandbox request: devnet has no deployment", async () => {
    const client = makeClient({});
    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        { owner: OWNER, providerReferences: [] }
      )
    ).rejects.toBeInstanceOf(SdpOndoError);
  });
});
