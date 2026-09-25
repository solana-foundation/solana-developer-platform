import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type SdpEnvironment,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";

/**
 * Mirrors the API's recurring-payment mint rule (`assertRecurringPaymentTokenMint`):
 * only well-known USD stablecoins on the active cluster or active tokens issued in
 * this project are eligible, so the editor never offers a mint the save rejects.
 */
export function eligibleRecurringPaymentAssets(
  options: ComboboxOption[],
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>,
  sdpEnvironment: SdpEnvironment
): ComboboxOption[] {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment];
  const activeIssuedMints = new Set(
    Object.values(issuedTokensByMint)
      .filter((token) => token.status === "active")
      .map((token) => token.mintAddress)
  );
  return options.filter((asset) => {
    if (activeIssuedMints.has(asset.value)) {
      return true;
    }
    const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(asset.value);
    return wellKnown?.isUsdStable === true && wellKnown.clusters.includes(cluster);
  });
}

/** Keeps `token` while it is still offered, otherwise falls back to the first eligible asset. */
export function fallbackRecurringPaymentToken(token: string, eligible: ComboboxOption[]): string {
  return eligible.some((asset) => asset.value === token) ? token : (eligible[0]?.value ?? "");
}
