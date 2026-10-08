const EARN_MOUNT_PATH = "/v1/earn";

/**
 * Earn exits (ADR 0002 exit safety): money already deployed must stay
 * withdrawable, so a production organization that loses the production
 * entitlement keeps every read and every way out of a position. Everything
 * else, deposits, program create/re-target, their quotes and any route added
 * later, is refused. An allowlist, so a new route fails closed (APE-351).
 */
const EARN_EXIT_POST_PATHS: readonly RegExp[] = [
  /^\/external-wallet\/withdrawal-previews$/,
  /^\/external-wallet\/withdrawal-transactions$/,
  /^\/external-wallet\/withdrawal-options$/,
  /^\/external-wallet\/queued-withdrawal-previews$/,
  /^\/external-wallet\/withdrawal-request-transactions$/,
  /^\/external-wallet\/withdrawal-request-cancel-transactions$/,
  /^\/external-wallet\/withdrawals$/,
  /^\/external-wallet\/withdrawal-requests$/,
  /^\/external-wallet\/withdrawal-request-cancellations$/,
  /^\/vault-withdrawals$/,
  /^\/vault-withdrawal-previews$/,
  /^\/vault-withdrawal-options$/,
  /^\/vault-queued-withdrawal-previews$/,
  /^\/vault-withdrawal-requests$/,
  /^\/vault-withdrawal-requests\/[^/]+\/cancel$/,
  /^\/programs\/[^/]+\/withdrawal-preview$/,
  /^\/programs\/[^/]+\/withdrawals$/,
];

export function isEarnExitOrRead(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  if (method !== "POST" || !path.startsWith(`${EARN_MOUNT_PATH}/`)) {
    return false;
  }
  const routePath = path.slice(EARN_MOUNT_PATH.length);
  return EARN_EXIT_POST_PATHS.some((pattern) => pattern.test(routePath));
}
