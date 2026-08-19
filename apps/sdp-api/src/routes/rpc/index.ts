import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { getRpcProviders, relayRpcRequest, testRpcConnection } from "./handlers";
import { rpcRelayPayloadSchema } from "./schemas";

const rpc = new Hono<{ Bindings: Env }>();

rpc.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
rpc.use("*", projectContextMiddleware());

rpc.get("/providers", requirePermissions("tokens:read"), getRpcProviders);
rpc.post("/test", requirePermissions("tokens:read"), testRpcConnection);
rpc.post(
  "/proxy",
  requirePermissions("tokens:write"),
  validateBody(rpcRelayPayloadSchema),
  relayRpcRequest
);

export default rpc;
