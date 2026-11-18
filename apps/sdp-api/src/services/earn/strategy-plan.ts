import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import { internalError } from "@/lib/errors";

/** The provider plan must encode exactly the admitted assets, amount and floor. */
export function requireAcceptedPlan(
  plan: EarnVaultTransactionPlan,
  input: { tokenMint: string; shareMint: string; amount: string; minSharesOut?: string }
): {
  minSharesOut: string | null;
} {
  if (plan.assetIdentity.depositTokenMint !== input.tokenMint) {
    throw internalError(
      "Vault builder deposit token mint does not match the admitted catalogue strategy"
    );
  }
  if (plan.assetIdentity.shareMint !== input.shareMint) {
    throw internalError("Vault builder share mint does not match the admitted catalogue strategy");
  }
  const amount = plan.accepted?.amount;
  if (!amount) {
    throw internalError("Vault builder did not report the canonical amount encoded on chain");
  }
  if (compareDecimalAmounts(amount, input.amount) !== 0) {
    throw internalError("Vault builder amount does not match the requested request amount");
  }
  const minSharesOut = plan.accepted?.minSharesOut ?? null;
  if (input.minSharesOut !== undefined && minSharesOut === null) {
    throw internalError("Vault builder omitted the canonical minSharesOut encoded on chain");
  }
  if (
    (input.minSharesOut === undefined && minSharesOut !== null) ||
    (input.minSharesOut !== undefined &&
      minSharesOut !== null &&
      compareDecimalAmounts(minSharesOut, input.minSharesOut) !== 0)
  ) {
    throw internalError("Vault builder minSharesOut does not match the requested slippage floor");
  }
  return { minSharesOut };
}

/** Withdrawal floors are token amounts, separate from deposit share floors. */
export function requireAcceptedWithdrawalPlan(
  plan: EarnVaultTransactionPlan,
  input: { tokenMint: string; shareMint: string; shares: string; minAmountOut?: string }
): void {
  if (plan.assetIdentity.depositTokenMint !== input.tokenMint) {
    throw internalError(
      "Vault builder deposit token mint does not match the position being exited"
    );
  }
  if (plan.assetIdentity.shareMint !== input.shareMint) {
    throw internalError("Vault builder share mint does not match the position being exited");
  }
  const shares = plan.accepted?.shares;
  if (!shares) {
    throw internalError("Vault builder did not report the canonical shares encoded on chain");
  }
  if (compareDecimalAmounts(shares, input.shares) !== 0) {
    throw internalError("Vault builder shares do not match the requested withdrawal");
  }
  // Same rule as the deposit's floor: what the instructions ENCODE must match
  // what policy approved, in both directions of disagreement.
  const minAmountOut = plan.accepted?.minAmountOut ?? null;
  if (input.minAmountOut !== undefined && minAmountOut === null) {
    throw internalError("Vault builder omitted the canonical minAmountOut encoded on chain");
  }
  if (
    (input.minAmountOut === undefined && minAmountOut !== null) ||
    (input.minAmountOut !== undefined &&
      minAmountOut !== null &&
      compareDecimalAmounts(minAmountOut, input.minAmountOut) !== 0)
  ) {
    throw internalError("Vault builder minAmountOut does not match the requested slippage floor");
  }
}
