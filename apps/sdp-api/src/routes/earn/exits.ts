import { MOVEMENTS, type MovementOf } from "@sdp/types/movements";

const EARN_POST_ROUTES: Readonly<Record<string, MovementOf<"earn">>> = {
  "/v1/earn/deposit": "earn.deposit",
  "/v1/earn/withdraw": "earn.withdraw",
};

/** File each core write explicitly; unknown writes never inherit exit access. */
export function earnPostRouteMovement(path: string): MovementOf<"earn"> | undefined {
  return EARN_POST_ROUTES[path];
}

/** Reads and exits remain available without the production deposit entitlement. */
export function isEarnExitOrRead(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST") return false;
  const movement = earnPostRouteMovement(path);
  return movement !== undefined && MOVEMENTS[movement].kind === "exit";
}
