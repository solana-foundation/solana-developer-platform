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
/**
 * The owner's real mainnet-beta USDY ATA under the classic token program —
 * the account the exit swap spends from (the API's swap service pins a
 * route's source to `findAssociatedTokenPda(owner, usdyMint)`).
 */
const OWNER_ATA = "AM5oZfoUpUUpokKFVQgE23hmPAVw3dtEQatFHnMNP8DP";
/** Any non-ATA token account: USDY parked where the exit swap cannot spend it. */
const AUX = "AuxTokenAccount1111111111111111111111111111111";
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

/**
 * Mirrors the real jsonParsed wire shape: `getTokenAccountsByOwner` reports
 * each account's `pubkey` and the SPL account state (`initialized` | `frozen`
 * | `uninitialized`) alongside the exact raw balance. A string entry means
 * the owner's own ATA, initialized — the common holding.
 */
function stubTokenAccounts(
  entries: (string | { amount: string; state?: string; pubkey?: string })[]
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: entries.map((entry) => {
            const amount = typeof entry === "string" ? entry : entry.amount;
            const state =
              typeof entry === "string" ? "initialized" : (entry.state ?? "initialized");
            const pubkey = typeof entry === "string" ? OWNER_ATA : (entry.pubkey ?? OWNER_ATA);
            return {
              pubkey,
              account: { data: { parsed: { info: { state, tokenAmount: { amount } } } } },
            };
          }),
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
    stubTokenAccounts(["1000000", { amount: "2500000", pubkey: AUX }]);
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
        // Only the ATA backs an exit: the string entry IS the ATA (1.0); the
        // auxiliary 2.5 is holding, not liquidity.
        withdrawableShares: "1",
        tokenValue: "4.006",
        tokenMint: USDC,
        shareMint: USDY,
      },
    ]);
  });

  it("keeps a nonzero frozen USDY account in holdings without claiming it is withdrawable", async () => {
    // Regression fixture for SOLA9-375: the exact wire shape of a frozen
    // mainnet USDY account (28,503,622 shares, parsed state "frozen").
    stubTokenAccounts([{ amount: "28503622000000", state: "frozen" }]);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "28503622", priceImpactPct: "0" }),
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    // The holding stays the truth: frozen tokens remain the owner's balance
    // and are still valued, but the token program will reject any transfer
    // out of a frozen account, so nothing there is immediately exitable.
    expect(positions[0]?.shares).toBe("28503622");
    expect(positions[0]?.withdrawableShares).toBe("0");
    expect(positions[0]?.tokenValue).toBe("28503622");
  });

  it("reports an initialized account as fully withdrawable", async () => {
    stubTokenAccounts([{ amount: "12000000", state: "initialized" }]);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "12", priceImpactPct: "0" }),
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares).toBe("12");
    expect(positions[0]?.withdrawableShares).toBe("12");
  });

  it("reports nothing withdrawable when the swap source is frozen, even with a transferable auxiliary account", async () => {
    // Greptile P1 regression: the exit swap spends from the ATA only (the
    // API's swap service pins the route's source to it), so USDY held in a
    // transferable auxiliary account cannot back a withdrawal while the ATA
    // itself is frozen.
    stubTokenAccounts([
      { amount: "28503622000000", state: "frozen", pubkey: OWNER_ATA },
      { amount: "5000000", state: "initialized", pubkey: AUX },
    ]);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "28508622", priceImpactPct: "0" }),
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares).toBe("28503627");
    expect(positions[0]?.withdrawableShares).toBe("0");
  });

  it("counts only the ATA toward withdrawableShares when a frozen auxiliary account exists", async () => {
    // The mirror case: the ATA is spendable, and the frozen auxiliary
    // balance is holding the route can never reach.
    stubTokenAccounts([
      { amount: "5000000", state: "initialized", pubkey: OWNER_ATA },
      { amount: "28503622000000", state: "frozen", pubkey: AUX },
    ]);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "28508622", priceImpactPct: "0" }),
    });

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares).toBe("28503627");
    expect(positions[0]?.withdrawableShares).toBe("5");
  });

  it("reports zero withdrawable when the ATA is closed but an auxiliary account holds the balance", async () => {
    stubTokenAccounts([{ amount: "5000000", state: "initialized", pubkey: AUX }]);
    const client = makeClient({});

    const positions = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [USDY],
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares).toBe("5");
    expect(positions[0]?.withdrawableShares).toBe("0");
  });

  it("fails closed when the RPC omits the parsed SPL account state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "12" } } } } } }],
          },
        })
      )
    );
    const client = makeClient({});
    await expect(
      client.readVaultPositions(CTX, { owner: OWNER, providerReferences: [USDY] })
    ).rejects.toMatchObject({ code: "POSITION_UNREADABLE" });
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
