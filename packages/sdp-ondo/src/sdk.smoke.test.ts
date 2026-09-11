import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { wellKnownMint } from "@sdp/types";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import {
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { OndoVaultDirectClient } from "./client";
import type { OndoSwapPort } from "./types";

/**
 * On-chain smoke test. **Opt-in, and never runs in CI** — the package's other
 * tests are pure and offline, per the repo rule.
 *
 * Run it against a surfpool surfnet forking MAINNET, which is the only place
 * the USDY instrument exists (Ondo has no devnet deployment; even their
 * staging runs on mainnet) — real mint, real Orca/Manifest liquidity, no
 * mainnet money at risk:
 *
 *   ONDO_SMOKE_RPC_URL=http://127.0.0.1:8899 \
 *   ONDO_SMOKE_SIGNER=<64 hex chars: 32 private key bytes> \
 *   pnpm --filter @sdp/ondo test
 *
 * Fund the signer first with SOL and USDC (surfpool's cheatcodes). What this
 * proves that the offline tests cannot: the swap plans this provider emits
 * actually SIMULATE and LAND through real routed liquidity, the floor
 * arithmetic holds against a live quote, and the position read reports what
 * the chain then holds — the full deposit → position → exit round trip.
 *
 * The swap port here speaks Jupiter's keyless lite API (v1 quote +
 * swap-instructions) so the test needs no credential. Production uses the
 * API-owned keyed port (`services/earn/ondo-swap-port.ts`), whose instruction
 * ADMISSION this test does not exercise — that boundary has its own suite.
 */
const RPC_URL = process.env.ONDO_SMOKE_RPC_URL;
const SIGNER_HEX = process.env.ONDO_SMOKE_SIGNER;
const LITE_BASE = process.env.ONDO_SMOKE_JUPITER_BASE ?? "https://lite-api.jup.ag/swap/v1";

const DEPOSIT_USDC = "100";
const TOKEN_DECIMALS = 6;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const USDY = ONDO_DEPLOYMENTS["mainnet-beta"]?.usdyMint as string;

interface LiteInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

function toPlanInstruction(instruction: LiteInstruction) {
  return {
    programAddress: instruction.programId,
    accounts: instruction.accounts.map((account) => ({
      address: account.pubkey,
      role: (account.isSigner ? 2 : 0) + (account.isWritable ? 1 : 0),
    })),
    data: instruction.data,
  };
}

async function liteQuote(inputMint: string, outputMint: string, amount: string, slippageBps = 50) {
  const atoms = parseDecimalAmount(amount, TOKEN_DECIMALS);
  const url =
    `${LITE_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${atoms}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const body = (await (await fetch(url)).json()) as {
    outAmount?: string;
    otherAmountThreshold?: string;
    priceImpactPct?: string;
    error?: string;
  };
  if (!body.outAmount || !body.otherAmountThreshold) {
    throw new Error(`lite quote failed: ${body.error ?? "no amounts"}`);
  }
  return body;
}

/** Keyless lite-API implementation of the swap seam, for the fork only. */
const litePort: OndoSwapPort = {
  async quoteSwap(request) {
    const quote = await liteQuote(request.inputMint, request.outputMint, request.amount);
    return {
      outAmount: formatDecimalAmount(BigInt(quote.outAmount as string), TOKEN_DECIMALS),
      priceImpactPct: String(quote.priceImpactPct ?? "0"),
    };
  },
  async buildSwapLeg(request) {
    const quote = await liteQuote(
      request.inputMint,
      request.outputMint,
      request.amount,
      request.slippageBps
    );
    const response = (await (
      await fetch(`${LITE_BASE}/swap-instructions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: request.owner,
          wrapAndUnwrapSol: false,
        }),
      })
    ).json()) as {
      setupInstructions?: LiteInstruction[];
      swapInstruction?: LiteInstruction;
      addressLookupTableAddresses?: string[];
      error?: string;
    };
    if (!response.swapInstruction) {
      throw new Error(`lite swap-instructions failed: ${response.error ?? "no instruction"}`);
    }
    return {
      instructions: [...(response.setupInstructions ?? []), response.swapInstruction].map(
        toPlanInstruction
      ),
      lookupTableAddresses: response.addressLookupTableAddresses ?? [],
      quotedAmount: formatDecimalAmount(BigInt(quote.outAmount as string), TOKEN_DECIMALS),
      minOutAmount: formatDecimalAmount(
        BigInt(quote.otherAmountThreshold as string),
        TOKEN_DECIMALS
      ),
      priceImpactPct: String(quote.priceImpactPct ?? "0"),
      routeLabels: [],
    };
  },
};

const CTX: EarnRuntimeContext = { env: {}, environment: "production" };

describe.skipIf(!RPC_URL || !SIGNER_HEX)("Ondo plans against a surfpool mainnet fork", () => {
  const client = new OndoVaultDirectClient(
    async () => RPC_URL ?? "",
    (_label, operation) => operation(() => {}),
    () => litePort
  );

  async function signer() {
    const bytes = Uint8Array.from(
      (SIGNER_HEX ?? "").match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []
    );
    return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  }

  async function signAndLand(plan: EarnVaultTransactionPlan) {
    const rpc = createSolanaRpc(RPC_URL ?? "");
    const owner = await signer();
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

    const instructions = plan.instructions.map((instruction) => ({
      programAddress: address(instruction.programAddress),
      accounts: instruction.accounts.map((account) => ({
        address: address(account.address),
        role: account.role,
      })),
      data: Buffer.from(instruction.data, "base64") as Uint8Array,
    }));

    let message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      // biome-ignore lint/suspicious/noExplicitAny: raw role numbers are the wire format the plan carries.
      (m) => appendTransactionMessageInstructions(instructions as any, m)
    );
    if (plan.lookupTables.length > 0) {
      const tables = await fetchAddressesForLookupTables(
        plan.lookupTables.map((table) => address(table)),
        rpc
      );
      message = compressTransactionMessageUsingAddressLookupTables(
        message,
        tables
      ) as unknown as typeof message;
    }

    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);

    const sim = await rpc
      .simulateTransaction(wire, { encoding: "base64", replaceRecentBlockhash: true })
      .send();
    expect(sim.value.err, `simulation failed: ${JSON.stringify(sim.value.logs)}`).toBeNull();

    const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
    // The surfnet lands in-slot; poll briefly rather than subscribing.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .send();
      const entry = status.value[0];
      if (entry) {
        expect(
          entry.err,
          `transaction failed on the fork: ${JSON.stringify(entry.err)}`
        ).toBeNull();
        return signature;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`transaction ${signature} did not land on the fork`);
  }

  it("deposits: quote → floor → build → simulate → land → position", async () => {
    const owner = await signer();

    const quote = await client.quoteVaultDeposit(CTX, {
      providerReference: USDY,
      amount: DEPOSIT_USDC,
    });
    expect(Number(quote.sharesOut)).toBeGreaterThan(0);

    // The dashboard derivation: floor = quote × (1 − 50bps), floored to scale.
    const quotedAtoms = parseDecimalAmount(quote.sharesOut, TOKEN_DECIMALS);
    const floor = formatDecimalAmount((quotedAtoms * 9_950n) / 10_000n, TOKEN_DECIMALS);

    const plan = await client.buildVaultDeposit(CTX, {
      providerReference: USDY,
      owner: owner.address,
      amount: DEPOSIT_USDC,
      minSharesOut: floor,
    });
    expect(plan.cluster).toBe("mainnet-beta");
    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: USDY });
    expect(plan.accepted).toEqual({ amount: DEPOSIT_USDC, minSharesOut: floor });

    await signAndLand(plan);

    const positions = await client.readVaultPositions(CTX, {
      owner: owner.address,
      providerReferences: [],
    });
    expect(positions).toHaveLength(1);
    const position = positions[0];
    expect(position).toBeDefined();
    if (!position) throw new Error("unreachable");
    expect(parseDecimalAmount(position.shares, TOKEN_DECIMALS)).toBeGreaterThanOrEqual(
      parseDecimalAmount(floor, TOKEN_DECIMALS)
    );
    if (position.tokenValue !== undefined) {
      expect(position.tokenValue).toMatch(/^\d+(\.\d+)?$/);
    }
  }, 120_000);

  it("withdraws the full position back to USDC", async () => {
    const owner = await signer();
    const [position] = await client.readVaultPositions(CTX, {
      owner: owner.address,
      providerReferences: [USDY],
    });
    expect(position).toBeDefined();
    if (!position) throw new Error("unreachable");
    expect(parseDecimalAmount(position.shares, TOKEN_DECIMALS)).toBeGreaterThan(0n);

    const quote = await client.quoteVaultWithdrawal(CTX, {
      providerReference: USDY,
      shares: position.shares,
    });
    const quotedAtoms = parseDecimalAmount(quote.assetsOut, TOKEN_DECIMALS);
    const floor = formatDecimalAmount((quotedAtoms * 9_950n) / 10_000n, TOKEN_DECIMALS);

    const plan = await client.buildVaultWithdrawal(CTX, {
      providerReference: USDY,
      owner: owner.address,
      shares: position.shares,
      minAmountOut: floor,
    });
    expect(plan.accepted).toEqual({ shares: position.shares, minAmountOut: floor });

    await signAndLand(plan);

    const after = await client.readVaultPositions(CTX, {
      owner: owner.address,
      providerReferences: [USDY],
    });
    expect(after[0]?.shares).toBe("0");
  }, 120_000);
});
