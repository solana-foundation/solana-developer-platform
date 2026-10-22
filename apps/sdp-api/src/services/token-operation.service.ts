import { AmountError, parseFixedDecimal } from "@sdp/solana/amount";
import { MOSAIC_AMOUNT_REFUSALS, MosaicAmountError } from "@sdp/solana/mosaic-amount";
import {
  type BaseUnits,
  parseTokenAmount,
  type TokenAmount,
  toBaseUnits,
} from "@sdp/solana/token-amount";
import { TOKEN_MOVEMENT_REFUSALS } from "@sdp/solana/token-movement";
import { TokenTermsError } from "@sdp/solana/token-terms";
import { AppError, badRequest } from "@/lib/errors";

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

/**
 * Parses an issuance amount at the token's recorded decimals. The issuance
 * services check that scale against the mint read live before Mosaic converts
 * the amount (`@sdp/solana/mosaic-amount`).
 *
 * @returns The exact token amount and its base units.
 * @throws AppError (`INVALID_TOKEN_AMOUNT`) when the amount is not a positive
 * decimal the mint can hold.
 */
export function parsePositiveTokenAmount(
  amount: string,
  decimals: number
): {
  amount: TokenAmount;
  amountBaseUnits: BaseUnits;
} {
  let tokenAmount: TokenAmount;
  try {
    tokenAmount = parseTokenAmount(amount, decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw toInvalidTokenAmountError(error.message);
    }

    throw error;
  }

  const amountBaseUnits = toBaseUnits(tokenAmount);
  if (amountBaseUnits <= 0n) {
    throw toInvalidTokenAmountError("Amount must be greater than zero.");
  }
  return { amount: tokenAmount, amountBaseUnits };
}

/**
 * Runs an issuance service call, answering its live-terms refusals as 400s:
 * a paused mint as `TOKEN_PAUSED`, an amount Mosaic cannot take exactly or a
 * recorded scale the mint no longer has as `INVALID_TOKEN_AMOUNT`, and a mint
 * state the issuance row refuses (or an account that is no mint) as
 * `BAD_REQUEST`. Nothing was built or signed when one is thrown.
 */
export async function withLiveIssuanceTerms<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof MosaicAmountError) {
      if (error.movementRefusal === TOKEN_MOVEMENT_REFUSALS.paused) {
        throw new AppError("TOKEN_PAUSED", error.message);
      }
      if (error.reason === MOSAIC_AMOUNT_REFUSALS.unsupported) {
        throw badRequest(error.message, { reason: error.movementRefusal });
      }
      throw toInvalidTokenAmountError(error.message);
    }
    if (error instanceof TokenTermsError) {
      throw badRequest(error.message, { reason: error.reason });
    }
    throw error;
  }
}

export function resolveMintOperationAmount(
  token: TokenWithStatus,
  amount: string
): {
  amount: TokenAmount;
  amountBaseUnits: BaseUnits;
  mintAddress: string;
} {
  assertTokenAllowsOperation(token, "mint");
  assertTokenIsDeployed(token);

  if (!token.isMintable) {
    throw new AppError("TOKEN_NOT_MINTABLE", "Token is not mintable");
  }

  const parsed = parsePositiveTokenAmount(amount, token.decimals);

  if (token.maxSupply) {
    // The recorded supply (with reservations) and the cap are SDP bookkeeping
    // that may pass u64, so they compare as generic fixed-point at the mint's scale.
    const currentSupply = parseFixedDecimal(token.totalSupply ?? "0", token.decimals);
    const maxSupply = parseFixedDecimal(token.maxSupply, token.decimals);

    if (currentSupply + parsed.amountBaseUnits > maxSupply) {
      throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
    }
  }

  return {
    ...parsed,
    mintAddress: token.mintAddress,
  };
}
