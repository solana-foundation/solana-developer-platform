import type { Context, Next } from "hono";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Admits only sandbox projects past a devnet-only surface.
 *
 * Helius Rings runs against devnet while sandbox and production projects are
 * served from the same process, so admission is a property of the selected
 * project's environment, not of the deployment's `SOLANA_NETWORK`: a
 * production project on a devnet-configured process would otherwise enter the
 * devnet-only workflow and record devnet state under a production tenant.
 *
 * Fails closed: a request whose project environment did not resolve is
 * rejected, never waved through. `projectContextMiddleware` must have run
 * first.
 */
export function requireSandboxProject() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (c.get("projectEnvironment") !== "sandbox") {
      throw forbidden("This surface is limited to sandbox projects");
    }
    await next();
  };
}
