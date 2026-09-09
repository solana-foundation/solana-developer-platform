import { SdpEarnError } from "@sdp/earn/errors";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import {
  fetchJupiterSwapLeg,
  type JupiterSwapRequest,
  prependSwapLegToVaultPlan,
} from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";

/**
 * The Jupiter swap leg: request shape, credential fail-close, wire → plan
 * conversion (instruction order, numeric account roles, lookup-table keys),
 * amount scaling through real mint decimals, and readable refusals for every
 * upstream failure class. `fetch` is stubbed — no network.
 */

const USDC = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;
const PYUSD = WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address;
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const AMM_KEY = "8gNiGmM7YtGz2CjNw1Cuja9BSTdBXDgFM9G5jTxeMLDF";
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";
const UNSUPPORTED_ROUTE_DISCRIMINATOR = "0000000000000000";
let SOURCE_TOKEN_ACCOUNT: string;
let DESTINATION_TOKEN_ACCOUNT: string;

const fetchMock = vi.fn();

function swapEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    JUPITER_SWAP_API_URL: "https://jupiter.mock.invalid/swap/v2",
    JUPITER_SWAP_API_KEY: "jup_test_key",
    ...overrides,
  } as Env;
}

function request(overrides: Partial<JupiterSwapRequest> = {}): JupiterSwapRequest {
  return {
    inputMint: USDC,
    outputMint: PYUSD,
    sourceAmount: "25",
    owner: OWNER,
    slippageBps: 50,
    ...overrides,
  };
}

function routeData(
  overrides: {
    discriminator?: string;
    inAmount?: bigint;
    quotedOutAmount?: bigint;
    slippageBps?: number;
    platformFeeBps?: number;
    positiveSlippageBps?: number;
    opaqueRoutePlan?: number[];
  } = {}
): string {
  const data = Buffer.alloc(8 + 1 + 8 + 8 + 2 + 2 + 2);
  Buffer.from(overrides.discriminator ?? SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR, "hex").copy(
    data,
    0
  );
  data.writeUInt8(0, 8); // shared route id
  data.writeBigUInt64LE(overrides.inAmount ?? 25_000_000n, 9);
  data.writeBigUInt64LE(overrides.quotedOutAmount ?? 24_990_000n, 17);
  data.writeUInt16LE(overrides.slippageBps ?? 50, 25);
  data.writeUInt16LE(overrides.platformFeeBps ?? 0, 27);
  data.writeUInt16LE(overrides.positiveSlippageBps ?? 0, 29);
  return Buffer.concat([data, Buffer.from(overrides.opaqueRoutePlan ?? [0, 0, 0, 0])]).toString(
    "base64"
  );
}

function directRouteData(): string {
  const data = Buffer.alloc(8 + 8 + 8 + 2 + 2 + 2 + 4);
  Buffer.from(ROUTE_V2_DISCRIMINATOR, "hex").copy(data, 0);
  data.writeBigUInt64LE(25_000_000n, 8);
  data.writeBigUInt64LE(24_990_000n, 16);
  data.writeUInt16LE(50, 24);
  data.writeUInt16LE(0, 26);
  data.writeUInt16LE(0, 28);
  return data.toString("base64");
}

function sharedRouteAccounts(
  overrides: Partial<
    Record<number, { pubkey: string; isSigner: boolean; isWritable: boolean }>
  > = {}
) {
  const accounts = [
    { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: OWNER, isSigner: true, isWritable: false },
    { pubkey: SOURCE_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: USDC, isSigner: false, isWritable: true },
    { pubkey: PYUSD, isSigner: false, isWritable: true },
    { pubkey: DESTINATION_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: USDC, isSigner: false, isWritable: false },
    { pubkey: PYUSD, isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAMS["spl-token"], isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAMS["token-2022"], isSigner: false, isWritable: false },
    { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: AMM_KEY, isSigner: false, isWritable: true },
  ];
  for (const [index, account] of Object.entries(overrides)) {
    if (account) accounts[Number(index)] = account;
  }
  return accounts;
}

function directRouteAccounts() {
  return [
    { pubkey: OWNER, isSigner: true, isWritable: false },
    { pubkey: SOURCE_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: DESTINATION_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: USDC, isSigner: false, isWritable: false },
    { pubkey: PYUSD, isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAMS["spl-token"], isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAMS["token-2022"], isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: AMM_KEY, isSigner: false, isWritable: true },
  ];
}

function swapInstruction(
  overrides: {
    programId?: string;
    data?: string;
    accounts?: ReturnType<typeof sharedRouteAccounts>;
  } = {}
) {
  return {
    programId: overrides.programId ?? JUPITER_PROGRAM,
    accounts: overrides.accounts ?? sharedRouteAccounts(),
    data: overrides.data ?? routeData(),
  };
}

function ataCreateInstruction(mint: string, tokenAccount: string, tokenProgram: string) {
  return {
    programId: ATA_PROGRAM,
    accounts: [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: OWNER, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: "AQ==",
  };
}

function buildResponse(overrides: Record<string, unknown> = {}) {
  return {
    inputMint: USDC,
    outputMint: PYUSD,
    inAmount: "25000000",
    outAmount: "24990000",
    otherAmountThreshold: "24865050",
    slippageBps: 50,
    priceImpactPct: "0.0001",
    routePlan: [{ swapInfo: { label: "Whirlpool" } }],
    computeBudgetInstructions: [],
    setupInstructions: [
      ataCreateInstruction(PYUSD, DESTINATION_TOKEN_ACCOUNT, SPL_TOKEN_PROGRAMS["token-2022"]),
    ],
    swapInstruction: swapInstruction(),
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {
      D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6: [OWNER],
    },
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

beforeAll(async () => {
  [[SOURCE_TOKEN_ACCOUNT], [DESTINATION_TOKEN_ACCOUNT]] = await Promise.all([
    findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(USDC),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
    }),
    findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(PYUSD),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["token-2022"]),
    }),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJupiterSwapLeg", () => {
  it("fails closed with PROVIDER_NOT_CONFIGURED when no API key is deployed", async () => {
    await expect(
      fetchJupiterSwapLeg(
        swapEnv({ JUPITER_SWAP_API_KEY: undefined }),
        createVaultDeadline(),
        request()
      )
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks /build for an ExactIn swap in source-token atoms, keyed and SOL-wrap-free", async () => {
    fetchMock.mockResolvedValue(okResponse(buildResponse()));

    await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://jupiter.mock.invalid/swap/v2/build");
    expect(parsed.searchParams.get("inputMint")).toBe(USDC);
    expect(parsed.searchParams.get("outputMint")).toBe(PYUSD);
    // "25" at USDC's 6 decimals — scaled through the pinned catalogue, never a float.
    expect(parsed.searchParams.get("amount")).toBe("25000000");
    expect(parsed.searchParams.get("taker")).toBe(OWNER);
    expect(parsed.searchParams.get("slippageBps")).toBe("50");
    expect(parsed.searchParams.get("wrapAndUnwrapSol")).toBe("false");
    expect(parsed.searchParams.get("maxAccounts")).toBe("40");
    expect(parsed.searchParams.get("instructionVersion")).toBe("V2");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("jup_test_key");
  });

  it("forwards an explicit maxAccounts (the compact-route retry)", async () => {
    fetchMock.mockResolvedValue(okResponse(buildResponse()));

    await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request({ maxAccounts: 24 }));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("maxAccounts")).toBe("24");
  });

  it("normalizes the answer: ordered instructions, numeric roles, tables, scaled amounts", async () => {
    fetchMock.mockResolvedValue(okResponse(buildResponse()));

    const leg = await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());

    // Exact idempotent ATA setup → validated Jupiter ExactIn route. Compute
    // price, cleanup, tip, and other response-controlled work is never admitted.
    expect(leg.instructions.map((instruction) => instruction.data)).toEqual(["AQ==", routeData()]);
    // Numeric AccountRole wire format: bit 0 writable, bit 1 signer.
    expect(leg.instructions[1]?.accounts[1]).toEqual({ address: OWNER, role: 2 });
    expect(leg.instructions[1]?.accounts[2]).toEqual({ address: SOURCE_TOKEN_ACCOUNT, role: 1 });
    expect(leg.lookupTableAddresses).toEqual(["D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6"]);
    expect(leg.sourceAmount).toBe("25");
    expect(leg.quotedAmount).toBe("24.99");
    // otherAmountThreshold at PYUSD's 6 decimals — the deposit-sizing floor.
    expect(leg.minOutAmount).toBe("24.86505");
    expect(leg.priceImpactPct).toBe("0.0001");
    expect(leg.routeLabels).toEqual(["Whirlpool"]);
    expect(leg.slippageBps).toBe(50);
  });

  it("refuses a funding or deposit mint outside the pinned catalogue", async () => {
    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request({ inputMint: OWNER }))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request({ outputMint: OWNER }))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a setup instruction outside the exact owner ATA contract", async () => {
    const FOREIGN_PROGRAM = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          setupInstructions: [{ programId: FOREIGN_PROGRAM, accounts: [], data: "AQ==" }],
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses a swap instruction that does not run Jupiter's aggregator, even an allowlisted program", async () => {
    // A "swap" that is really a bare token instruction is a substituted
    // operation, not a route, regardless of whether the program is otherwise
    // a legitimate part of Solana token handling.
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          swapInstruction: {
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            accounts: sharedRouteAccounts(),
            data: routeData(),
          },
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses an instruction that requires a signer other than the owner", async () => {
    const FOREIGN_SIGNER = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          swapInstruction: swapInstruction({
            accounts: sharedRouteAccounts({
              0: { pubkey: FOREIGN_SIGNER, isSigner: true, isWritable: false },
            }),
          }),
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it.each(["setupInstructions", "cleanupInstruction", "otherInstructions"] as const)(
    "refuses a taker-authorized token transfer smuggled into %s",
    async (field) => {
      const transfer = {
        programId: SPL_TOKEN_PROGRAMS["spl-token"],
        accounts: [
          { pubkey: SOURCE_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
          { pubkey: USDC, isSigner: false, isWritable: true },
          { pubkey: OWNER, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
      };
      const override =
        field === "cleanupInstruction" ? { [field]: transfer } : { [field]: [transfer] };
      fetchMock.mockResolvedValue(okResponse(buildResponse(override)));

      await expect(
        fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    }
  );

  it("refuses an ATA create whose owner, mint, address, token program, or opcode is not exact", async () => {
    const malformed = ataCreateInstruction(
      PYUSD,
      DESTINATION_TOKEN_ACCOUNT,
      SPL_TOKEN_PROGRAMS["token-2022"]
    );
    malformed.accounts[2] = { pubkey: USDC, isSigner: false, isWritable: false };
    fetchMock.mockResolvedValue(okResponse(buildResponse({ setupInstructions: [malformed] })));

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it.each([
    ["inputMint", OWNER],
    ["outputMint", OWNER],
    ["inAmount", "24999999"],
    ["slippageBps", 51],
  ] as const)("refuses a quote with mismatched %s", async (field, value) => {
    fetchMock.mockResolvedValue(okResponse(buildResponse({ [field]: value })));

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses a route that sends output anywhere but the owner's pinned ATA", async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          swapInstruction: swapInstruction({
            accounts: sharedRouteAccounts({
              5: { pubkey: USDC, isSigner: false, isWritable: true },
            }),
          }),
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it.each([
    ["amount", routeData({ inAmount: 24_999_999n })],
    ["quoted output", routeData({ quotedOutAmount: 24_989_999n })],
    ["slippage", routeData({ slippageBps: 51 })],
    ["platform fee", routeData({ platformFeeBps: 1 })],
    ["positive slippage", routeData({ positiveSlippageBps: 1 })],
    ["instruction variant", routeData({ discriminator: UNSUPPORTED_ROUTE_DISCRIMINATOR })],
  ] as const)("refuses a swap instruction with mismatched %s semantics", async (_field, data) => {
    fetchMock.mockResolvedValue(
      okResponse(buildResponse({ swapInstruction: swapInstruction({ data }) }))
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("keeps Jupiter route internals opaque behind the pinned aggregator boundary", async () => {
    const accounts = sharedRouteAccounts();
    accounts.push({ pubkey: AMM_KEY, isSigner: false, isWritable: true });
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          routePlan: [{ swapInfo: { label: "AlphaQ" } }, { swapInfo: { label: "Whirlpool" } }],
          swapInstruction: swapInstruction({
            accounts,
            // The route bytes and remaining venue accounts belong to the
            // allowlisted Jupiter program. SDP validates the stable outer
            // economic envelope without coupling to Jupiter's private enum.
            data: routeData({ opaqueRoutePlan: [2, 0, 0, 0, 101, 17, 16, 39] }),
          }),
        })
      )
    );

    const leg = await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());

    expect(leg.routeLabels).toEqual(["AlphaQ", "Whirlpool"]);
    expect(leg.instructions[1]?.accounts.at(-1)).toEqual({ address: AMM_KEY, role: 1 });
  });

  it("accepts Jupiter's non-shared ExactIn V2 route with the same fixed semantics", async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          setupInstructions: [],
          swapInstruction: swapInstruction({
            accounts: directRouteAccounts(),
            data: directRouteData(),
          }),
        })
      )
    );

    const leg = await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());

    expect(leg.instructions).toHaveLength(1);
    expect(leg.instructions[0]?.accounts[0]).toEqual({ address: OWNER, role: 2 });
    expect(leg.instructions[0]?.accounts[2]).toEqual({
      address: DESTINATION_TOKEN_ACCOUNT,
      role: 1,
    });
  });

  it("surfaces a Jupiter 400 as a caller-fault refusal carrying Jupiter's own reason", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "No route found for this pair" }), { status: 400 })
    );

    const attempt = fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toThrowError(/No route found for this pair/);
  });

  it("answers a Jupiter 5xx as an upstream failure, never a caller fault", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toBeInstanceOf(SdpEarnError);
  });

  it("refuses malformed amounts rather than scaling garbage", async () => {
    fetchMock.mockResolvedValue(
      okResponse(buildResponse({ otherAmountThreshold: "not-a-number" }))
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toThrowError(/malformed amounts/);
  });

  it("refuses a zero post-slippage output instead of building a zero deposit", async () => {
    fetchMock.mockResolvedValue(okResponse(buildResponse({ otherAmountThreshold: "0" })));

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toThrowError(/zero after slippage/);
  });
});

describe("prependSwapLegToVaultPlan", () => {
  it("prepends the swap instructions and unions lookup tables, keeping provider testimony", async () => {
    fetchMock.mockResolvedValue(okResponse(buildResponse()));
    const leg = await fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request());

    const providerInstruction = {
      programAddress: JUPITER_PROGRAM,
      accounts: [],
      data: "ZGVwb3NpdA==",
    };
    const plan = {
      cluster: "mainnet-beta" as const,
      instructions: [providerInstruction],
      lookupTables: [
        "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
        "8gNiGmM7YtGz2CjNw1Cuja9BSTdBXDgFM9G5jTxeMLDF",
      ],
      assetIdentity: { depositTokenMint: PYUSD, shareMint: USDC },
      accepted: { amount: "24.86505" },
      createsShareAccount: true,
    };

    const composed = prependSwapLegToVaultPlan(plan, leg);

    expect(composed.instructions.map((instruction) => instruction.data)).toEqual([
      "AQ==",
      routeData(),
      "ZGVwb3NpdA==",
    ]);
    expect(composed.lookupTables).toEqual([
      "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
      "8gNiGmM7YtGz2CjNw1Cuja9BSTdBXDgFM9G5jTxeMLDF",
    ]);
    expect(composed.assetIdentity).toEqual(plan.assetIdentity);
    expect(composed.accepted).toEqual(plan.accepted);
    expect(composed.createsShareAccount).toBe(true);
    // The input plan is not mutated.
    expect(plan.instructions).toHaveLength(1);
  });
});
