import { Hono } from "hono";
import { requireClerkSession, unifiedAuthMiddleware } from "@/middleware/auth";
import { publicRoute } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { getNetworkSnapshot } from "./handlers";

/**
 * Chain-wide Solana figures for the dashboard's Overview. Dashboard sessions only: it is no part
 * of the API. Not metered: every request reads the cache, which reads data.solana.com about every
 * 3 hours whatever the traffic.
 */
const internalNetwork = new Hono<{ Bindings: Env }>();

internalNetwork.use("*", unifiedAuthMiddleware());
internalNetwork.use("*", requireClerkSession());

internalNetwork.get(
  "/",
  publicRoute("a dashboard session reads chain-wide figures; no tenant data"),
  getNetworkSnapshot
);

export default internalNetwork;
