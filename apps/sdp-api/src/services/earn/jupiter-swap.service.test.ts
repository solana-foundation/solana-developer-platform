import { SdpEarnError } from "@sdp/earn/errors";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function apiInstruction(
  data: string,
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] = []
) {
  return { programId: JUPITER_PROGRAM, accounts, data };
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
    routePlan: [{ swapInfo: { label: "Whirlpool" } }, { swapInfo: {} }],
    computeBudgetInstructions: [apiInstruction("Y29tcHV0ZQ==")],
    setupInstructions: [apiInstruction("c2V0dXA=")],
    swapInstruction: apiInstruction("c3dhcA==", [
      { pubkey: OWNER, isSigner: true, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false },
    ]),
    cleanupInstruction: apiInstruction("Y2xlYW51cA=="),
    otherInstructions: [],
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

    // setup → swap → cleanup, with compute-budget instructions excluded: the
    // vault pipeline neither prices priority fees nor tips, and the composed
    // transaction must simulate exactly as it will be sent.
    expect(leg.instructions.map((instruction) => instruction.data)).toEqual([
      "c2V0dXA=",
      "c3dhcA==",
      "Y2xlYW51cA==",
    ]);
    // Numeric AccountRole wire format: bit 0 writable, bit 1 signer.
    expect(leg.instructions[1]?.accounts).toEqual([
      { address: OWNER, role: 3 },
      { address: USDC, role: 0 },
    ]);
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

  it("refuses an instruction for a program outside the pinned allowlist", async () => {
    // A structurally valid program address that is none of: Jupiter, System,
    // Token, Token-2022, ATA. Whatever it does, it has no business in a
    // transaction the owner authorizes wholesale.
    const FOREIGN_PROGRAM = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          setupInstructions: [{ programId: FOREIGN_PROGRAM, accounts: [], data: "c2V0dXA=" }],
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses a swap instruction that does not run Jupiter's aggregator, even an allowlisted program", async () => {
    // The SPL Token program is allowlisted for setup/cleanup housekeeping, but
    // a "swap" that is really a bare token instruction is a substituted
    // operation, not a route.
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          swapInstruction: {
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            accounts: [{ pubkey: OWNER, isSigner: true, isWritable: true }],
            data: "c3dhcA==",
          },
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses an instruction that requires a signer other than the owner", async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        buildResponse({
          swapInstruction: apiInstruction("c3dhcA==", [
            { pubkey: OWNER, isSigner: true, isWritable: true },
            // A second authority: the owner's wholesale signature must never
            // be joined by (or depend on) anyone else's.
            { pubkey: USDC, isSigner: true, isWritable: false },
          ]),
        })
      )
    );

    await expect(
      fetchJupiterSwapLeg(swapEnv(), createVaultDeadline(), request())
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
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
      "c2V0dXA=",
      "c3dhcA==",
      "Y2xlYW51cA==",
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
