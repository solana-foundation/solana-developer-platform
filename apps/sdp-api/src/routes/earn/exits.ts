import { exitPurposeForRequest } from "@/lib/movement-exits";

/**
 * Earn exits (ADR 0002 exit safety): money already deployed must stay
 * withdrawable, so a production organization that loses the production
 * entitlement keeps every read and every way out of a position. The exit
 * routes are the `earn.withdraw` entries of the shared exit allowlist
 * (`lib/movement-exits.ts`, HOO-1955); everything else is refused (APE-351).
 * Reads stay Earn's own decision: other modules do not open GETs.
 */
export function isEarnExitOrRead(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  return path.startsWith("/v1/earn/") && exitPurposeForRequest(method, path) === "earn.withdraw";
}
