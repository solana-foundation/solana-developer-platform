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
 * (HOO-1955). A preview or option lookup signs nothing and is a read. A start
 * is refused like an unfiled route; it is filed so `movement-actions.test.ts`
 * can hold its route's action to the movement's.
 */
const EARN_POST_ROUTES: readonly { path: RegExp; movement: MovementOf<"earn"> | "read" }[] = [
  { path: /^\/vault-deposits$/, movement: "earn.deposit" },
  { path: /^\/external-wallet\/deposit-transactions$/, movement: "earn.deposit" },
  { path: /^\/external-wallet\/deposits$/, movement: "earn.deposit" },
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

/**
 * The movement an Earn POST builds or submits: `"read"` when it signs nothing,
 * undefined when the route is not filed.
 *
 * @param path - A request path under `/v1/earn`.
 */
export function earnPostRouteMovement(path: string): MovementOf<"earn"> | "read" | undefined {
  if (!path.startsWith(`${EARN_MOUNT_PATH}/`)) {
    return undefined;
  }
  const routePath = path.slice(EARN_MOUNT_PATH.length);
  return EARN_POST_ROUTES.find((candidate) => candidate.path.test(routePath))?.movement;
}

export function isEarnExitOrRead(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  if (method !== "POST") {
    return false;
  }
  const movement = earnPostRouteMovement(path);
  if (movement === undefined) {
    return false;
  }
  return movement === "read" || MOVEMENTS[movement].kind === "exit";
}
