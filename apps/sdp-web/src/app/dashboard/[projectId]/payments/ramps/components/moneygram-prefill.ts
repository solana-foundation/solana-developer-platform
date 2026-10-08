import { toNumberAmount } from "@sdp/solana/amount";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoAssetSymbol } from "@sdp/types/payment-rails";

/**
 * Transaction prefill handed to MoneyGram's Ramps SDK. Amounts, asset and
 * destination only: the widget collects the customer's phone, address and
 * identity itself, so nothing personal is ever passed through here.
 */
export interface MoneygramTransactionPrefill {
  type: "off-ramp" | "on-ramp";
  destinationCountry?: string;
  destinationSubdivision?: string;
  destinationCurrency?: string;
  amount?: number;
  asset?: CryptoAssetSymbol;
}

export function buildOfframpTransactionPrefill(
  fiatCurrency: RampFiatCurrency,
  cryptoAsset: CryptoAssetSymbol,
  cryptoAmount: string
): MoneygramTransactionPrefill {
  const destinationCountry =
    fiatCurrency === "USD" ? "USA" : fiatCurrency === "MXN" ? "MEX" : undefined;
  return {
    type: "off-ramp",
    ...(destinationCountry ? { destinationCountry } : {}),
    destinationCurrency: fiatCurrency,
    amount: toNumberAmount(cryptoAmount),
    asset: cryptoAsset,
  };
}

export function buildOnrampTransactionPrefill(
  fiatAmount: string,
  cryptoAsset: CryptoAssetSymbol
): MoneygramTransactionPrefill {
  return {
    type: "on-ramp",
    amount: toNumberAmount(fiatAmount),
    asset: cryptoAsset,
  };
}
