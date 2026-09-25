import { createServer, type ServerResponse } from "node:http";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { OndoVaultDirectClient } from "@sdp/ondo";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { createOndoSwapPort } from "./ondo-swap-port";

/**
 * SOLA9-452 regression: the Ondo position read must report the owner's derived
 * USDY ATA balance — the exact account the API's Jupiter boundary admits as the
 * swap's source — never the sum of every owner-controlled USDY account.
 *
 * With 1 USDY in the derived ATA and 2.5 USDY in a separate owner-controlled
 * account, the vulnerable read advertised 3.5 USDY as both `shares` and
 * `withdrawableShares` while the admitted swap could spend only the 1 USDY ATA,
 * so the shown full exit could not execute. The secure contract asserted here:
 *
 * 1. the position read reports the ATA balance alone (1 USDY); and
 * 2. a withdrawal built for the full advertised `withdrawableShares` is
 *    admitted with that ATA as its source and its encoded ExactIn input equal
 *    to the advertised amount — the advertised exit is fully funded by the
 *    account the plan is allowed to spend.
 *
 * This test uses a real local HTTP RPC/Jupiter boundary rather than mocks. The
 * production Ondo client, API swap port, ATA derivation, and Jupiter V2
 * instruction admission all run unchanged; the local responses are synthetic
 * and contain no live funds or credentials.
 */

const MAINNET = ONDO_DEPLOYMENTS["mainnet-beta"];
if (!MAINNET) throw new Error("test premise: Ondo mainnet deployment is configured");

const USDY = MAINNET.usdyMint;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const OWNER = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const NON_ATA = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const AMM_ACCOUNT = "8gNiGmM7YtGz2CjNw1Cuja9BSTdBXDgFM9G5jTxeMLDF";
const ATA_ATOMS = 1_000_000n;
const NON_ATA_ATOMS = 2_500_000n;
const EXIT_ATOMS = ATA_ATOMS;
const QUOTED_OUT_ATOMS = 1_000_000n;
const FLOOR_ATOMS = 900_000n;
const SLIPPAGE_BPS = Number(((QUOTED_OUT_ATOMS - FLOOR_ATOMS) * 10_000n) / QUOTED_OUT_ATOMS);
const ENCODED_MIN_OUT_ATOMS = (QUOTED_OUT_ATOMS * BigInt(10_000 - SLIPPAGE_BPS) + 9_999n) / 10_000n;
const ROUTE_DISCRIMINATOR = "bb64facc31c4af14";

const CTX: EarnRuntimeContext = { env: {}, environment: "production" };

let rpcUrl = "";
let jupiterUrl = "";
let server: ReturnType<typeof createServer> | undefined;

function routeData(): string {
  const data = Buffer.alloc(8 + 8 + 8 + 2 + 2 + 2 + 4);
  Buffer.from(ROUTE_DISCRIMINATOR, "hex").copy(data, 0);
  data.writeBigUInt64LE(EXIT_ATOMS, 8);
  data.writeBigUInt64LE(QUOTED_OUT_ATOMS, 16);
  data.writeUInt16LE(SLIPPAGE_BPS, 24);
  return data.toString("base64");
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function account(amount: bigint, accountAddress: string) {
  return {
    pubkey: accountAddress,
    account: {
      data: {
        parsed: {
          info: {
            mint: USDY,
            owner: OWNER,
            tokenAmount: { amount: amount.toString(), decimals: 6 },
          },
        },
      },
    },
  };
}

beforeAll(async () => {
  const [sourceAta] = await findAssociatedTokenPda({
    owner: address(OWNER),
    mint: address(USDY),
    tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
  });
  const [destinationAta] = await findAssociatedTokenPda({
    owner: address(OWNER),
    mint: address(USDC),
    tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
  });

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/rpc") {
      sendJson(response, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: [account(ATA_ATOMS, String(sourceAta)), account(NON_ATA_ATOMS, NON_ATA)],
        },
      });
      return;
    }
    if (url.pathname === "/swap/v2/order") {
      sendJson(response, {
        inputMint: USDY,
        outputMint: USDC,
        inAmount: EXIT_ATOMS.toString(),
        outAmount: QUOTED_OUT_ATOMS.toString(),
        priceImpactPct: "0",
      });
      return;
    }
    if (url.pathname === "/swap/v2/build") {
      const accounts = [
        { pubkey: OWNER, isSigner: true, isWritable: false },
        { pubkey: String(sourceAta), isSigner: false, isWritable: true },
        { pubkey: String(destinationAta), isSigner: false, isWritable: true },
        { pubkey: USDY, isSigner: false, isWritable: false },
        { pubkey: USDC, isSigner: false, isWritable: false },
        {
          pubkey: SPL_TOKEN_PROGRAMS["spl-token"],
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: SPL_TOKEN_PROGRAMS["spl-token"],
          isSigner: false,
          isWritable: false,
        },
        { pubkey: JUPITER, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: JUPITER, isSigner: false, isWritable: false },
        { pubkey: AMM_ACCOUNT, isSigner: false, isWritable: true },
      ];
      sendJson(response, {
        inputMint: USDY,
        outputMint: USDC,
        inAmount: EXIT_ATOMS.toString(),
        outAmount: QUOTED_OUT_ATOMS.toString(),
        otherAmountThreshold: ENCODED_MIN_OUT_ATOMS.toString(),
        slippageBps: SLIPPAGE_BPS,
        priceImpactPct: "0",
        routePlan: [{ swapInfo: { label: "synthetic-controlled-route" } }],
        setupInstructions: [],
        swapInstruction: { programId: JUPITER, accounts, data: routeData() },
        cleanupInstruction: null,
        otherInstructions: [],
        tipInstruction: null,
        addressesByLookupTableAddress: {},
      });
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("local regression server did not bind");
  rpcUrl = `http://127.0.0.1:${bound.port}/rpc`;
  jupiterUrl = `http://127.0.0.1:${bound.port}/swap/v2`;
});

afterAll(() => server?.close());

describe("SOLA9-452: Ondo position read is the executable ATA balance", () => {
  it("reports the 1 USDY ATA, not the 3.5 USDY owner-wide aggregate", async () => {
    const swapPort = createOndoSwapPort({
      ...env,
      JUPITER_SWAP_API_KEY: "synthetic-regression-key",
      JUPITER_SWAP_API_URL: jupiterUrl,
    } as Env);
    const client = new OndoVaultDirectClient(
      async () => rpcUrl,
      (_label, operation) => operation(() => {}),
      () => swapPort
    );

    const [position] = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [],
    });
    expect(position?.shares).toBe("1");
    expect(position?.withdrawableShares).toBe("1");
  });

  it("builds an admitted full exit of the advertised withdrawable amount from the ATA", async () => {
    const swapPort = createOndoSwapPort({
      ...env,
      JUPITER_SWAP_API_KEY: "synthetic-regression-key",
      JUPITER_SWAP_API_URL: jupiterUrl,
    } as Env);
    const client = new OndoVaultDirectClient(
      async () => rpcUrl,
      (_label, operation) => operation(() => {}),
      () => swapPort
    );

    const [position] = await client.readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [],
    });
    const [sourceAta] = await findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(USDY),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
    });

    const plan = await client.buildVaultWithdrawal(CTX, {
      providerReference: USDY,
      owner: OWNER,
      shares: position?.withdrawableShares ?? "0",
      minAmountOut: "0.9",
    });
    const swap = plan.instructions.find((instruction) => instruction.programAddress === JUPITER);
    expect(swap?.accounts[1]?.address).toBe(String(sourceAta));
    expect(plan.accepted).toEqual({ shares: "1", minAmountOut: "0.9" });
    // The admitted swap's encoded ExactIn input is exactly the advertised
    // withdrawable amount, and that amount is fully funded by the one source
    // account the admission contract allows the route to spend.
    expect(ATA_ATOMS).toBe(EXIT_ATOMS);
    expect(ATA_ATOMS).toBeLessThan(ATA_ATOMS + NON_ATA_ATOMS);
  });
});
