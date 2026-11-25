import {
  AmountError,
  acceptTokenAmount,
  formatDecimalAmount,
  TokenAmountError,
} from "@sdp/solana/amount";
import { HASTRA_PAR_MINIMUM_ASSET_ATOMS, TOKEN_DECIMALS, U64_MAX } from "./constants";
import { SdpHastraError } from "./errors";
import type { StakePriceState } from "./state";

export function canonicalAmount(value: string, label: string): { text: string; atoms: bigint } {
  try {
    const { baseUnits, canonical } = acceptTokenAmount(value, TOKEN_DECIMALS, { positive: true });
    return { text: canonical, atoms: baseUnits };
  } catch (cause) {
    if (
      cause instanceof TokenAmountError &&
      (cause.reason === "out_of_range" || cause.reason === "not_positive")
    ) {
      throw new SdpHastraError("INVALID_AMOUNT", `${label} must be between one atom and u64::MAX.`);
    }
    if (cause instanceof AmountError) {
      throw new SdpHastraError(
        "INVALID_AMOUNT",
        `${label} is not usable at the ${TOKEN_DECIMALS}-decimal token scale: ${cause.message}`
      );
    }
    throw cause;
  }
}

export function formatAtoms(atoms: bigint): string {
  return formatDecimalAmount(atoms, TOKEN_DECIMALS);
}

export function sharesForAssets(assets: bigint, price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  const result = (assets * price.scale) / price.price;
  if (result > U64_MAX) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's live rate converts this amount beyond the PRIME mint's u64 range."
    );
  }
  return result;
}

export function assetsForShares(shares: bigint, price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  const result = (shares * price.price) / price.scale;
  if (result > U64_MAX) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's live rate converts this amount beyond the wYLDS mint's u64 range."
    );
  }
  return result;
}

export function minimumSharesForPar(price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  return (HASTRA_PAR_MINIMUM_ASSET_ATOMS * price.scale + price.price - 1n) / price.price;
}
