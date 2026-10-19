import { MOVEMENTS, type MovementOf } from "@sdp/types/movements";

const EARN_MOUNT_PATH = "/v1/earn";

/**
 * Earn exits (ADR 0002 exit safety): money already deployed must stay
 * withdrawable, so a production organization that loses the production
 * entitlement keeps every read and every way out of a position. Everything
 * else, deposits, program create/re-target, their quotes and any route added
 * later, is refused. An allowlist, so a new route fails closed (APE-351).
 *
 * Each route names the movement it builds or submits, and `MOVEMENTS` decides
 * whether that is an exit, so the edge and the signer cannot disagree
 * (HOO-1955). A preview or option lookup signs nothing and is a read.
 */
const EARN_POST_ROUTES: readonly { path: RegExp; movement: MovementOf<"earn"> | "read" }[] = [
  { path: /^\/external-wallet\/withdrawal-previews$/, movement: "read" },
  { path: /^\/external-wallet\/withdrawal-transactions$/, movement: "earn.withdraw" },
  { path: /^\/external-wallet\/withdrawal-options$/, movement: "read" },
  { path: /^\/external-wallet\/queued-withdrawal-previews$/, movement: "read" },
  {
    path: /^\/external-wallet\/withdrawal-request-transactions$/,
    movement: "earn.queued_withdraw_request",
  },
  {
    path: /^\/external-wallet\/withdrawal-request-cancel-transactions$/,
    movement: "earn.queued_withdraw_cancel",
  },
  { path: /^\/external-wallet\/withdrawals$/, movement: "earn.withdraw" },
  { path: /^\/external-wallet\/withdrawal-requests$/, movement: "earn.queued_withdraw_request" },
  {
    path: /^\/external-wallet\/withdrawal-request-cancellations$/,
    movement: "earn.queued_withdraw_cancel",
  },
  { path: /^\/vault-withdrawals$/, movement: "earn.withdraw" },
  { path: /^\/vault-withdrawal-previews$/, movement: "read" },
  { path: /^\/vault-withdrawal-options$/, movement: "read" },
  { path: /^\/vault-queued-withdrawal-previews$/, movement: "read" },
  { path: /^\/vault-withdrawal-requests$/, movement: "earn.queued_withdraw_request" },
  { path: /^\/vault-withdrawal-requests\/[^/]+\/cancel$/, movement: "earn.queued_withdraw_cancel" },
  { path: /^\/programs\/[^/]+\/withdrawal-preview$/, movement: "read" },
  { path: /^\/programs\/[^/]+\/withdrawals$/, movement: "earn.withdraw" },
];

export function isEarnExitOrRead(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  if (method !== "POST" || !path.startsWith(`${EARN_MOUNT_PATH}/`)) {
    return false;
  }
  const routePath = path.slice(EARN_MOUNT_PATH.length);
  const route = EARN_POST_ROUTES.find((candidate) => candidate.path.test(routePath));
  if (!route) {
    return false;
  }
  return route.movement === "read" || MOVEMENTS[route.movement].kind === "exit";
}
