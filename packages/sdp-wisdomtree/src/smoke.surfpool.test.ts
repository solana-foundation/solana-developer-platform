import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { beforeAll, describe, expect, it } from "vitest";
import { createWisdomTreeChainReader } from "./chain";
import { SdpWisdomTreeError } from "./errors";
import { buildWisdomTreeDepositPlan, buildWisdomTreeRedemptionPlan } from "./plan";
import { encodeWisdomTreeFundTokenAccount } from "./token-account";

/**
 * On-chain smoke test against a surfpool surfnet FORKING MAINNET. **Opt-in,
 * never in CI** — every other test in this package is offline.
 *
 *   surfpool start --no-tui   # forks mainnet-beta on :8899
 *   WISDOMTREE_SMOKE_RPC_URL=http://127.0.0.1:8899 \
 *   WISDOMTREE_SMOKE_SIGNER=<64 hex chars: 32 private key bytes> \
 *   pnpm --filter @sdp/wisdomtree test
 *
 * What it proves that the offline tests cannot, against the REAL WTGXX mint,
 * hook program, and ExtraAccountMetaList:
 *
 * 1. The subscription leg (USDC to the on-receipt wallet, plus the owner's
 *    fund-token ATA creation) SIMULATES CLEANLY for any funded wallet — the
 *    deposit's on-chain half carries no compliance gate of its own.
 * 2. The redemption leg FAILS AT THE KYC STAGE for a wallet WisdomTree never
 *    verified: either this package's hook resolver refuses (HOOK_UNRESOLVED —
 *    a required compliance account does not exist for the unverified wallet),
 *    or the fully-resolved transfer simulates and the hook program itself
 *    rejects it. Both outcomes are the compliance model working, and the test
 *    accepts exactly those two and nothing else.
 *
 * The Connect API is deliberately NOT exercised (SDP holds no credentials);
 * the on-receipt wallet is a stub address, which changes nothing about what
 * the chain enforces.
 */
const RPC_URL = process.env.WISDOMTREE_SMOKE_RPC_URL;
const SIGNER_HEX = process.env.WISDOMTREE_SMOKE_SIGNER;

const WTGXX = WISDOMTREE_FUNDS[0];
const HOOK_PROGRAM = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;

describe.skipIf(!RPC_URL || !SIGNER_HEX)("WisdomTree plans against a mainnet fork", () => {
  const runtime = { cluster: "mainnet-beta" as const, rpcUrl: RPC_URL ?? "" };

  async function signer() {
    const bytes = Uint8Array.from(
      (SIGNER_HEX ?? "").match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? []
    );
    return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  }

  async function cheat(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(RPC_URL ?? "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`${method} failed: ${body.error.message}`);
    }
    return body.result;
  }

  const hex = (data: Uint8Array): string =>
    [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  async function simulate(
    // The SAME signer instance the plan was built with — kit refuses two
    // distinct signer objects for one address.
    owner: Awaited<ReturnType<typeof signer>>,
    instructions: Parameters<typeof appendTransactionMessageInstructions>[0]
  ) {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    return await rpc
      .simulateTransaction(wire, { encoding: "base64", replaceRecentBlockhash: true })
      .send();
  }

  beforeAll(async () => {
    const owner = await signer();
    await cheat("surfnet_setAccount", [
      String(owner.address),
      {
        lamports: 10_000_000_000,
        owner: "11111111111111111111111111111111",
        data: "",
        executable: false,
        rentEpoch: 0,
      },
    ]);
    await cheat("surfnet_setTokenAccount", [
      String(owner.address),
      USDC,
      { amount: 1_000_000_000 },
    ]);
    // Fund tokens for the redemption leg — a balance the owner could only have
    // via cheatcode, since the real mint only settles to verified wallets.
    const [ownerFundAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: address(WTGXX.mint),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["token-2022"]),
    });
    await cheat("surfnet_setAccount", [
      String(ownerFundAta),
      {
        lamports: 10_000_000,
        owner: SPL_TOKEN_PROGRAMS["token-2022"],
        data: hex(
          encodeWisdomTreeFundTokenAccount(address(WTGXX.mint), owner.address, 5_000_000_000n)
        ),
        executable: false,
        rentEpoch: 0,
      },
    ]);
  });

  it("subscription: builds against the live mint and simulates cleanly", async () => {
    const owner = await signer();
    const onReceiptStub = await generateKeyPairSigner();
    const reader = createWisdomTreeChainReader(runtime.rpcUrl);

    const plan = await buildWisdomTreeDepositPlan(reader, runtime, {
      fund: WTGXX,
      owner,
      onReceiptWallet: onReceiptStub.address,
      depositMint: address(USDC),
      depositDecimals: 6,
      amount: "250",
    });

    expect(plan.accepted).toEqual({ amount: "250" });
    const sim = await simulate(owner, [...plan.instructions]);
    expect(
      sim.value.err,
      `subscription simulation failed: ${JSON.stringify(sim.value.logs)}`
    ).toBeNull();
  });

  it("redemption: fails at the KYC stage for an unverified wallet", async () => {
    const owner = await signer();
    const onReceiptStub = await generateKeyPairSigner();
    const reader = createWisdomTreeChainReader(runtime.rpcUrl);

    let plan: Awaited<ReturnType<typeof buildWisdomTreeRedemptionPlan>>;
    try {
      plan = await buildWisdomTreeRedemptionPlan(reader, runtime, {
        fund: WTGXX,
        owner,
        onReceiptWallet: onReceiptStub.address,
        depositMint: address(USDC),
        shares: "1",
      });
    } catch (error) {
      // KYC refusal, form 1: the hook's account recipes need compliance state
      // that does not exist for this wallet, so resolution fails closed.
      expect(error).toBeInstanceOf(SdpWisdomTreeError);
      expect((error as SdpWisdomTreeError).code).toBe("HOOK_UNRESOLVED");
      expect((error as SdpWisdomTreeError).message).toMatch(/compliance account|not been verified/);
      return;
    }

    // KYC refusal, form 2: the accounts resolved, so the transfer reaches the
    // hook program on-chain and the hook itself must reject the transfer.
    const sim = await simulate(owner, [...plan.instructions]);
    expect(
      sim.value.err,
      "an unverified wallet's redemption must NOT simulate cleanly"
    ).not.toBeNull();
    const logs = (sim.value.logs ?? []).join("\n");
    expect(logs, `expected the WisdomTree compliance hook in the failure logs:\n${logs}`).toContain(
      `Program ${HOOK_PROGRAM} invoke`
    );
    expect(logs, `expected the unverified-wallet SBT refusal:\n${logs}`).toContain(
      "Error Code: EmptySbtAccount. Error Number: 13013. " +
        "Error Message: Empty SBT account: account has no data."
    );
  });
});
