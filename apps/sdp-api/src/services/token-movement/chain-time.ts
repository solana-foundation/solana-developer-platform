/**
 * A chain time (the Clock sysvar's Unix seconds) as ISO 8601, the form the
 * API reports a terms read, a display `asOf` or a quote's expiry in.
 */
export function chainTimeIso(unixTimestamp: bigint): string {
  return new Date(Number(unixTimestamp) * 1000).toISOString();
}
