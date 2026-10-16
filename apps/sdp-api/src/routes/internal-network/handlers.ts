import type { Context } from "hono";
import { success } from "@/lib/response";
import { readNetworkSnapshot } from "@/services/network/network.service";
import type { Env } from "@/types/env";

/**
 * `GET /internal/dashboard/network`: the Overview's network snapshot.
 *
 * @param c - The request's context: its environment, cache store and background runner.
 * @returns The snapshot in the success envelope.
 */
export async function getNetworkSnapshot(c: Context<{ Bindings: Env }>) {
  return success(
    c,
    await readNetworkSnapshot(c.env, c.var.kv.cache, (promise) => c.executionCtx.waitUntil(promise))
  );
}
