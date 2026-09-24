import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import type { PreparedPaymentSubscriptionTransaction } from "@sdp/types";
import type { Address, Instruction } from "@solana/kit";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { findPlanPda } from "@solana/subscriptions";
import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { badRequest } from "@/lib/errors";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { parseU64String } from "@/services/payment-operation.service";
import { type AppContext, getSponsoredFeePayer } from "../context";
import { resolveMintDecimals, resolveMintTokenProgram, SOL_MINT } from "../token-accounts";
import { resolveScope, resolveWallet } from "../wallets";

export function assertSubscriptionTokenMint(token: string): Address {
  if (token === "SOL" || token === SOL_MINT) {
    throw badRequest("Subscription plans require an SPL token mint");
  }

  return assertValidAddress(token, "token");
}

export async function buildPreparedSubscriptionTransaction(
  c: AppContext,
  instructions: Instruction[],
  requiredSigners: Address[],
  feePayerOverride?: Address
): Promise<PreparedPaymentSubscriptionTransaction> {
  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayer = feePayerOverride ?? (await getSponsoredFeePayer(c));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const compiled = compileTransaction(message);
  const signers = new Set<string>([...requiredSigners.map(String), String(feePayer)]);

  return {
    serialized: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash as string,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    requiredSigners: Array.from(signers),
  };
}

export async function resolvePlanRuntime(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  amount: string = plan.amount
): Promise<{ amountBaseUnits: bigint; mint: Address; tokenProgram: Address }> {
  const mint = assertSubscriptionTokenMint(plan.token);
  const rpc = solanaRpc.createRpc(c.env);
  const [tokenProgram, decimals] = await Promise.all([
    resolveMintTokenProgram(rpc, mint),
    resolveMintDecimals(rpc, mint),
  ]);
  const amountBaseUnits = parseDecimalAmount(amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw badRequest("Subscription amount must be greater than zero");
  }

  return { amountBaseUnits, mint, tokenProgram };
}

export async function derivePlanAddresses(
  plan: PaymentSubscriptionPlanRow
): Promise<{ owner: Address; planId: bigint; planPda: Address }> {
  const owner = assertValidAddress(plan.owner_address, "ownerAddress");
  const planId = parseU64String(plan.program_plan_id, "programPlanId");
  const [planPda] = await findPlanPda({ owner, planId });

  return { owner, planId, planPda };
}

export async function resolvePlanWriteWallet(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  walletId = plan.owner_wallet_id
) {
  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
  return wallet;
}
