import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { HASTRA_PAR_MINIMUM_ASSET_ATOMS, TOKEN_DECIMALS, U64_MAX } from "./constants";
import { SdpHastraError } from "./errors";
import type { StakePriceState } from "./state";

export function canonicalAmount(value: string, label: string): { text: string; atoms: bigint } {
  let atoms: bigint;
  try {
    atoms = parseDecimalAmount(value, TOKEN_DECIMALS);
  } catch (cause) {
    if (cause instanceof AmountError) {
      throw new SdpHastraError(
        "INVALID_AMOUNT",
        `${label} is not usable at the ${TOKEN_DECIMALS}-decimal token scale: ${cause.message}`
      );
    }
    throw cause;
  }
  if (atoms <= 0n || atoms > U64_MAX) {
    throw new SdpHastraError("INVALID_AMOUNT", `${label} must be between one atom and u64::MAX.`);
  }
  return { text: formatDecimalAmount(atoms, TOKEN_DECIMALS), atoms };
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
