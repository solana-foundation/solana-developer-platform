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
  { path: /^\/deposits\/execute$/, movement: "earn.deposit" },
  { path: /^\/deposits\/build-unsigned-transaction$/, movement: "earn.deposit" },
  { path: /^\/deposits\/submit-signed-transaction$/, movement: "earn.deposit" },
  { path: /^\/withdrawals\/caller-signed\/preview$/, movement: "read" },
  { path: /^\/withdrawals\/build-unsigned-transaction$/, movement: "earn.withdraw" },
  { path: /^\/withdrawals\/caller-signed\/options$/, movement: "read" },
  { path: /^\/withdrawal-requests\/caller-signed\/preview$/, movement: "read" },
  {
    path: /^\/withdrawal-requests\/build-unsigned-transaction$/,
    movement: "earn.queued_withdraw_request",
  },
  {
    path: /^\/withdrawal-requests\/cancel\/build-unsigned-transaction$/,
    movement: "earn.queued_withdraw_cancel",
  },
  { path: /^\/withdrawals\/submit-signed-transaction$/, movement: "earn.withdraw" },
  {
    path: /^\/withdrawal-requests\/submit-signed-transaction$/,
    movement: "earn.queued_withdraw_request",
  },
  {
    path: /^\/withdrawal-requests\/cancel\/submit-signed-transaction$/,
    movement: "earn.queued_withdraw_cancel",
  },
  { path: /^\/withdrawals\/execute$/, movement: "earn.withdraw" },
  { path: /^\/withdrawals\/provider-signed\/preview$/, movement: "read" },
  { path: /^\/withdrawals\/provider-signed\/options$/, movement: "read" },
  { path: /^\/withdrawal-requests\/provider-signed\/preview$/, movement: "read" },
  { path: /^\/withdrawal-requests\/execute$/, movement: "earn.queued_withdraw_request" },
  {
    path: /^\/withdrawal-requests\/[^/]+\/cancel\/execute$/,
    movement: "earn.queued_withdraw_cancel",
  },
  { path: /^\/portfolio-accounts\/[^/]+\/withdrawals\/preview$/, movement: "read" },
  { path: /^\/portfolio-accounts\/[^/]+\/withdrawals\/execute$/, movement: "earn.withdraw" },
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
