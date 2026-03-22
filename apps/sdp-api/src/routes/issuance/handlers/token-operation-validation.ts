import { AmountError, parseDecimalAmount, toMosaicAmount } from "@/lib/amount";
import { AppError } from "@/lib/errors";

type TokenWithStatus = {
  status: "pending" | "active" | "paused" | "revoked";
};

export function assertTokenAllowsSupplyOperation(
  token: TokenWithStatus,
  action: "mint" | "burn"
): void {
  if (token.status === "paused") {
    throw new AppError("TOKEN_PAUSED", `Token is paused. Unpause it to ${action}.`);
  }

  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", `Token must be active to ${action}.`);
  }
}

function toInvalidTokenAmountError(message: string): AppError {
  return new AppError("INVALID_TOKEN_AMOUNT", message, {
    field: "amount",
    hint: "Provide a positive token amount that matches this token's decimal precision.",
  });
}

export function parsePositiveTokenAmount(
  amount: string,
  decimals: number
): {
  amountBaseUnits: bigint;
  mosaicAmount: number;
} {
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseDecimalAmount(amount, decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw toInvalidTokenAmountError(error.message);
    }

    throw error;
  }

  if (amountBaseUnits <= 0n) {
    throw toInvalidTokenAmountError("Amount must be greater than zero.");
  }

  try {
    return {
      amountBaseUnits,
      mosaicAmount: toMosaicAmount(amount, decimals),
    };
  } catch (error) {
    if (error instanceof AmountError) {
      throw toInvalidTokenAmountError(error.message);
    }

    throw error;
  }
}
