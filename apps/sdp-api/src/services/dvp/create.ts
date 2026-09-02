/**
 * Creating a DvP trade.
 *
 * Flow A from PRO-1830: SDP holds one leg in a custody wallet, the counterparty
 * is an arbitrary address we know nothing about.
 *
 * Two things about `CreateDvp` shape this whole function.
 *
 * Only the PAYER signs. `user_a`, `user_b` and `settlement_authority` are plain
 * accounts on the instruction, so the counterparty signs nothing here and needs
 * no integration with us. Verified on devnet by creating a trade with addresses
 * we hold no keys for. It also means the instruction creates no obligation: a
 * SwapDvp is a proposal until someone funds it.
 *
 * And because it is permissionless, a created trade is NOT proof of agreement.
 * Anyone can create one naming anyone, and the economic terms are not part of
 * the PDA seeds, so the address does not bind them. Whoever funds has to verify
 * the stored terms first, which is what `verifySwapDvp` + `assertSwapDvpTerms`
 * in `@sdp/dvp` are for.
 */

import {
  DVP_SWAP_PROGRAM_ADDRESS,
  findSwapDvpEscrowAta,
  findSwapDvpPda,
  getCreateDvpInstruction,
} from "@sdp/dvp";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  none,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
} from "@solana/kit";
import { signTransactionMessageWithSigners } from "@solana/signers";
import { createDvpTradeRepository, type DvpTradeRow, type DvpTradeSide } from "@/db/repositories";
import { badRequest } from "@/lib/errors";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { randomDvpNonce } from "./nonce";
import { validateDvpTerms } from "./validate";

/** Seed prefix of the per-trade nonce tombstone (`NONCE_TOMBSTONE_SEED`). */
const NONCE_TOMBSTONE_SEED = "nonce";

export interface CreateDvpTradeInput {
  organizationId: string;
  projectId: string;
  /** Custody wallet holding SDP's leg. Also the fee payer and create payer. */
  sdpWalletId: string;
  /** Which leg SDP delivers. The counterparty takes the other one. */
  sdpSide: DvpTradeSide;
  /** The other party. An arbitrary address; we hold no key for it. */
  counterparty: string;
  /** Asset leg mint and its token program. */
  mintA: string;
  tokenProgramA: string;
  /** Cash leg mint and its token program. */
  mintB: string;
  tokenProgramB: string;
  amountA: bigint;
  amountB: bigint;
  expiryTimestamp: bigint;
  earliestSettlementTimestamp: bigint | null;
  refString: string | null;
}

/** Derives the per-trade nonce tombstone, seeds `[b"nonce", swap_dvp]`. */
async function findNonceTombstone(swapDvp: Address): Promise<Address> {
  const [tombstone] = await getProgramDerivedAddress({
    programAddress: DVP_SWAP_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode(NONCE_TOMBSTONE_SEED), getAddressEncoder().encode(swapDvp)],
  });
  return tombstone;
}

/**
 * Creates a DvP trade on chain and records it.
 *
 * @param env - API process environment.
 * @param input - The trade to create.
 * @returns The persisted trade, including the escrow addresses to publish.
 */
export async function createDvpTrade(env: Env, input: CreateDvpTradeInput): Promise<DvpTradeRow> {
  const settlementAuthority = env.DVP_SETTLEMENT_AUTHORITY;
  if (!settlementAuthority) {
    // Not a user error: the deployment is missing configuration. Only this key
    // can ever settle or cancel, so creating trades without one would produce
    // trades nobody can complete.
    throw badRequest("DvP settlement authority is not configured");
  }

  // The custody wallet is SDP's party, the create payer and the fee payer. It
  // signs once for all three.
  const signer = await createOrgSignerForCustodyWallet(
    env,
    input.organizationId,
    input.projectId,
    input.sdpWalletId
  );

  const userA = input.sdpSide === "a" ? signer.address : address(input.counterparty);
  const userB = input.sdpSide === "b" ? signer.address : address(input.counterparty);

  // Front-run the program's own checks so a bad payload is a 400 naming the
  // field rather than a round trip returning `custom program error: 0x5`.
  const problems = validateDvpTerms(
    {
      userA,
      userB,
      settlementAuthority,
      mintA: input.mintA,
      mintB: input.mintB,
      amountA: input.amountA,
      amountB: input.amountB,
      expiryTimestamp: input.expiryTimestamp,
      earliestSettlementTimestamp: input.earliestSettlementTimestamp,
      refString: input.refString,
    },
    Math.floor(Date.now() / 1000)
  );
  if (problems.length > 0) {
    throw badRequest(`Invalid DvP terms: ${problems.join("; ")}`);
  }

  // Cryptographically random, and a bigint throughout. A predictable nonce lets
  // a third party squat the address before the real parties reach it, and a
  // value routed through a JS number rounds above 2^53 and derives a different
  // PDA than the one we would publish.
  const nonce = randomDvpNonce();
  const mintA = address(input.mintA);
  const mintB = address(input.mintB);
  const tokenProgramA = address(input.tokenProgramA);
  const tokenProgramB = address(input.tokenProgramB);

  const [swapDvp] = await findSwapDvpPda({
    settlementAuthority: address(settlementAuthority),
    userA,
    userB,
    mintA,
    mintB,
    nonce,
  });
  const [nonceTombstone, [escrowA], [escrowB]] = await Promise.all([
    findNonceTombstone(swapDvp),
    findSwapDvpEscrowAta({ swapDvp, mint: mintA, tokenProgram: tokenProgramA }),
    findSwapDvpEscrowAta({ swapDvp, mint: mintB, tokenProgram: tokenProgramB }),
  ]);

  const instruction = getCreateDvpInstruction({
    payer: signer,
    swapDvp,
    nonceTombstone,
    settlementAuthority: address(settlementAuthority),
    userA,
    userB,
    mintA,
    mintB,
    dvpAtaA: escrowA,
    dvpAtaB: escrowB,
    tokenProgramA,
    tokenProgramB,
    amountA: input.amountA,
    amountB: input.amountB,
    expiryTimestamp: input.expiryTimestamp,
    nonce,
    refString: input.refString,
    // Omitted destinations are recorded as the party's own address by the
    // program, so leaving these null means "proceeds go to the counterparty",
    // which is the default every flow in PRO-1830 wants.
    userASettlementDestination: null,
    userBSettlementDestination: null,
    earliestSettlementTimestamp:
      input.earliestSettlementTimestamp === null ? none() : some(input.earliestSettlementTimestamp),
  });

  const rpc = solanaRpc.createRpc(env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature: Signature = await solanaRpc.sendTransaction(
    rpc,
    new Uint8Array(getTransactionEncoder().encode(signed))
  );

  // Persisted AFTER the program accepts it. The six seed values are what
  // RecoverDvp needs to rescue a deposit that lands once the trade has closed,
  // so losing them is unrecoverable rather than merely inconvenient.
  return createDvpTradeRepository(env).create({
    id: `dvp_${crypto.randomUUID().replace(/-/g, "")}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    swapDvp,
    settlementAuthority,
    userA,
    userB,
    mintA: input.mintA,
    mintB: input.mintB,
    nonce: nonce.toString(),
    tokenProgramA: input.tokenProgramA,
    tokenProgramB: input.tokenProgramB,
    amountA: input.amountA.toString(),
    amountB: input.amountB.toString(),
    expiryTimestamp: input.expiryTimestamp.toString(),
    earliestSettlementTimestamp: input.earliestSettlementTimestamp?.toString() ?? null,
    // The program stores an omitted destination as the party's own address, so
    // mirror that rather than storing null and having to branch on read.
    userASettlementDestination: userA,
    userBSettlementDestination: userB,
    refString: input.refString,
    escrowA,
    escrowB,
    sdpSide: input.sdpSide,
    sdpWalletId: input.sdpWalletId,
    createSignature: signature,
  });
}
