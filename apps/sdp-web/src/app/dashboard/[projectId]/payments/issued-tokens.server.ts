import { issuance } from "@/flags";
import type { SdpApiClient } from "@/lib/sdp-api";
import {
  type FetchResult,
  fetchIssuedTokensByMint,
  fetchPaymentsIssuedTokenSymbols,
  type PaymentsIssuedTokenSymbol,
} from "./payments-page.data";

/**
 * The organization's issued token symbols for labelling payment rows, read only where Issuance
 * is on: a deployment without it refuses `/v1/issuance/tokens`, so every other surface gets an
 * empty list instead of a 403 on each render.
 *
 * @param request - The request-scoped SDP API client's `request`.
 * @returns The issued token symbols, or an empty success when Issuance is off for this request.
 */
export async function fetchIssuedTokenSymbolsWhenIssuanceEnabled(
  request: SdpApiClient["request"]
): Promise<FetchResult<PaymentsIssuedTokenSymbol[]>> {
  return (await issuance()) ? fetchPaymentsIssuedTokenSymbols(request) : { ok: true, data: [] };
}

/**
 * {@link fetchIssuedTokensByMint} behind the same Issuance gate as
 * {@link fetchIssuedTokenSymbolsWhenIssuanceEnabled}.
 *
 * @param request - The request-scoped SDP API client's `request`.
 * @returns The issued tokens keyed by mint, or none when Issuance is off for this request.
 */
export async function fetchIssuedTokensByMintWhenIssuanceEnabled(
  request: SdpApiClient["request"]
): Promise<Record<string, PaymentsIssuedTokenSymbol>> {
  return (await issuance()) ? fetchIssuedTokensByMint(request) : {};
}
