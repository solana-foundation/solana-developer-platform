import type { Context } from "hono";
import type { MOVEMENT_PURPOSES, MovementPurpose } from "@/lib/admit-movement";
import type { Env } from "@/types/env";

/** The purposes whose kind is `exit` in {@link MOVEMENT_PURPOSES}. */
export type ExitPurpose = {
  [P in MovementPurpose]: (typeof MOVEMENT_PURPOSES)[P]["kind"] extends "exit" ? P : never;
}[MovementPurpose];

interface ExitRoute {
  method: "POST";
  path: RegExp;
  purpose: ExitPurpose;
}

/**
 * One definition of "exit" for the HTTP edge and the sinks (HOO-1955). Each
 * route names an exit purpose, so the type refuses a route whose purpose is a
 * start, and the handler mints its movement with that same purpose.
 * `projectContextMiddleware` lets these routes through for a production
 * organization that lost the entitlement (ADR 0002, APE-351); `admitMovement`
 * admits their purpose for deleted and unentitled organizations alike.
 *
 * An allowlist, so a new route fails closed. DvP reclaim and cancel and
 * private-channel withdrawals join it in their own slices; until then #2228's
 * edge refusal still applies to them. Some Earn entries are previews
 * and route discovery on the way out: they sign nothing, but an exit that
 * cannot be quoted cannot be taken.
 */
export const EXIT_ROUTES: readonly ExitRoute[] = [
  ...[
    /^\/v1\/earn\/external-wallet\/withdrawal-previews$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-transactions$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-options$/,
    /^\/v1\/earn\/external-wallet\/queued-withdrawal-previews$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-request-transactions$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-request-cancel-transactions$/,
    /^\/v1\/earn\/external-wallet\/withdrawals$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-requests$/,
    /^\/v1\/earn\/external-wallet\/withdrawal-request-cancellations$/,
    /^\/v1\/earn\/vault-withdrawals$/,
    /^\/v1\/earn\/vault-withdrawal-previews$/,
    /^\/v1\/earn\/vault-withdrawal-options$/,
    /^\/v1\/earn\/vault-queued-withdrawal-previews$/,
    /^\/v1\/earn\/vault-withdrawal-requests$/,
    /^\/v1\/earn\/vault-withdrawal-requests\/[^/]+\/cancel$/,
    /^\/v1\/earn\/programs\/[^/]+\/withdrawal-preview$/,
    /^\/v1\/earn\/programs\/[^/]+\/withdrawals$/,
  ].map((path): ExitRoute => ({ method: "POST", path, purpose: "earn.withdraw" })),
  {
    method: "POST",
    path: /^\/v1\/payments\/recurring-payments\/[^/]+\/cancel$/,
    purpose: "recurring.cancel",
  },
];

/** The exit purpose a request declares, or null when it is not an exit. */
export function exitPurposeForRequest(method: string, path: string): ExitPurpose | null {
  return (
    EXIT_ROUTES.find((route) => route.method === method && route.path.test(path))?.purpose ?? null
  );
}

/** `projectContextMiddleware`'s `allowUnentitledProduction` for every module with exits. */
export function isExitRequest(c: Context<{ Bindings: Env }>): boolean {
  return exitPurposeForRequest(c.req.method, c.req.path) !== null;
}
