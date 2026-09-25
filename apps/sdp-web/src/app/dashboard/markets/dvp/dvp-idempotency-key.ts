import type { SolanaCluster } from "@sdp/types";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

/**
 * A fresh Idempotency-Key for a DvP request, from `getRandomValues` rather than
 * `randomUUID`: the latter needs a secure context, and a dashboard reached over
 * plain http on a LAN address has none.
 *
 * @param prefix - Names the action, so a key read in a log says what it guarded.
 */
export function freshDvpIdempotencyKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Durable idempotency keys for the two actions that CLOSE a trade: settle and
 * cancel (SOLA9-146).
 *
 * A close is signed, recorded on its idempotency row, and broadcast under a
 * close lock that dies with the transaction's block height. While the claim is
 * live a retry is refused with 409; once it expires, a retry WITHOUT the
 * original key would sign and sponsor a second close against an escrow a late
 * deposit may have refilled. With the key, the API replays the first close's
 * signature instead of signing again — so the browser owes the operation one
 * stable key, minted once and re-sent on every retry of the same logical close.
 *
 * The shared store gives that key the same tiers the Earn and Private Channels
 * movements get: `sessionStorage` so it survives a reload mid-flight, memory
 * when storage is refused, and an approval hold that outlives the default TTL.
 * The mint is the `getRandomValues` one above, for the plain-http deployments.
 */
export const dvpCloseIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:dvp:close:idempotency:v1",
  { mint: () => freshDvpIdempotencyKey("dvp-close") }
);

/**
 * What makes two presses the SAME close: the cluster, the trade, and which
 * close it is. A settle on another trade, or a cancel on this one, is a
 * different operation with a key of its own.
 */
export function dvpCloseRequestFingerprint(input: {
  cluster: SolanaCluster;
  tradeId: string;
  action: "settle" | "cancel";
}): string {
  return JSON.stringify([input.cluster, input.tradeId, input.action]);
}
