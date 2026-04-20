import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { getRpcProviders, relayRpcRequest, testRpcConnection } from "./handlers";

const rpc = new Hono<{ Bindings: Env }>();

rpc.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

rpc.get("/providers", requirePermissions("tokens:read"), getRpcProviders);
rpc.post("/test", requirePermissions("tokens:read"), testRpcConnection);
rpc.post("/proxy", requirePermissions("tokens:write"), relayRpcRequest);

export default rpc;
