import { AmountError, parseDecimalAmount, toMosaicAmount } from "@/lib/amount";
import { AppError } from "@/lib/errors";

type TokenWithStatus = {
  status: "pending" | "active" | "paused" | "revoked";
  mintAddress?: string | null;
  isMintable?: boolean;
  totalSupply?: string;
  maxSupply?: string | null;
  decimals: number;
};

export type TokenOperation = "mint" | "burn" | "force_burn" | "seize";

const OPERATION_LABELS: Record<TokenOperation, string> = {
  mint: "mint",
  burn: "burn",
  force_burn: "force burn",
  seize: "seize",
};

export function assertTokenAllowsOperation(
  token: TokenWithStatus,
  operation: TokenOperation
): void {
  const action = OPERATION_LABELS[operation];

  if (token.status === "paused") {
    throw new AppError("TOKEN_PAUSED", `Token is paused. Unpause it to ${action}.`);
  }

  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", `Token must be active to ${action}.`);
  }
}

export function assertTokenIsDeployed<T extends TokenWithStatus>(
  token: T
): asserts token is T & { mintAddress: string } {
  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
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

export function resolveMintOperationAmount(
  token: TokenWithStatus,
  amount: string
): {
  amountBaseUnits: bigint;
  mintAddress: string;
  mosaicAmount: number;
} {
  assertTokenAllowsOperation(token, "mint");
  assertTokenIsDeployed(token);

  if (!token.isMintable) {
    throw new AppError("TOKEN_NOT_MINTABLE", "Token is not mintable");
  }

  const parsed = parsePositiveTokenAmount(amount, token.decimals);

  if (token.maxSupply) {
    const currentSupply = parseDecimalAmount(token.totalSupply ?? "0", token.decimals);
    const maxSupply = parseDecimalAmount(token.maxSupply, token.decimals);

    if (currentSupply + parsed.amountBaseUnits > maxSupply) {
      throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
    }
  }

  return {
    ...parsed,
    mintAddress: token.mintAddress,
  };
}
