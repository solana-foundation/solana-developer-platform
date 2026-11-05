import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { fetchPrivateChannelInstance } from "@/lib/private-channels";
import { extractSdpApiErrorMessage, type SdpApiClient, SdpApiResponseError } from "@/lib/sdp-api";

/**
 * Result envelope for a server-side Private Channels read.
 *
 * The transport helpers in `@/lib/private-channels` throw on any non-2xx; `ok` lets the caller
 * tell a failed read from "no instance". `data` carries `null` on failure, never a guess.
 */
export type PrivateChannelsResult<T> = {
  ok: boolean;
  data: T;
  error?: string;
  /** HTTP status when the failure came from the API rather than the network. */
  status?: number;
};

/** The project's connected instance, or `null` when none is persisted. */
export async function loadInstance(
  client: SdpApiClient
): Promise<PrivateChannelsResult<PrivateChannelInstance | null>> {
  try {
    return { ok: true, data: (await fetchPrivateChannelInstance(client)).instance ?? null };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: extractSdpApiErrorMessage(error),
      ...(error instanceof SdpApiResponseError ? { status: error.status } : {}),
    };
  }
}

/** A verified wallet's channel-side balance for a single mint. */
export interface WalletChannelBalance {
  uiAmount: string;
  mint: string;
  /** Raw base-unit amount + decimals, kept so balances can be summed per mint
   * without decimal-string arithmetic (the overview aggregates across wallets). */
  amount: string;
  decimals: number;
}
