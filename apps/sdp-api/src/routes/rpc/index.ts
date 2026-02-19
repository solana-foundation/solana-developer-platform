import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { getRpcProviders, relayRpcRequest } from "./handlers";

const rpc = new Hono<{ Bindings: Env }>();

rpc.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

rpc.get("/providers", requirePermissions("tokens:read"), getRpcProviders);
rpc.post("/proxy", requirePermissions("tokens:write"), relayRpcRequest);

export default rpc;
