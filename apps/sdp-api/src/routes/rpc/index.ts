import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { payloadTooLarge } from "@/lib/errors";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { type MeteredQuotaConfig, meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { getRpcProviders, relayRpcRequest, testRpcConnection } from "./handlers";
import { rpcRelayPayloadSchema } from "./schemas";

// Every admitted relay or test call becomes an upstream node call, billed to
// the tenant's provider or to the platform pool. The dashboard playground and
// SDK polling both burst, so the actor ceiling stays above interactive use.
export const RPC_QUOTA: MeteredQuotaConfig = { name: "rpc", actorMax: 300, orgMax: 1200 };

// A JSON-RPC request is small; sendTransaction payloads top out well under
// this. Bounding the body keeps a single request from buffering arbitrary
// bytes before validation runs.
const MAX_BODY_BYTES = 1024 * 1024;

const rpc = new Hono<{ Bindings: Env }>();

rpc.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
rpc.use("*", projectContextMiddleware());
rpc.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw payloadTooLarge();
    },
  })
);

rpc.get("/providers", requirePermissions("tokens:read"), getRpcProviders);
// The quota sits after the permission gate: callers the route would reject
// must not be able to charge the org-wide pool and starve authorized users.
rpc.post("/test", requirePermissions("tokens:read"), meteredQuota(RPC_QUOTA), testRpcConnection);
rpc.post(
  "/proxy",
  requirePermissions("tokens:write"),
  validateBody(rpcRelayPayloadSchema),
  meteredQuota(RPC_QUOTA),
  relayRpcRequest
);

export default rpc;
