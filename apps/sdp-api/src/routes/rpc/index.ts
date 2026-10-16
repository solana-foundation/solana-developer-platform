import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { payloadTooLarge } from "@/lib/errors";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { type MeteredQuotaConfig, meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { relayRpcRequest } from "./handlers";
import { rpcRelayPayloadSchema } from "./schemas";

// Every admitted relay call becomes an upstream node call on SDP's managed
// pool. The dashboard playground and SDK polling both burst, so the actor
// ceiling stays above interactive use.
const RPC_QUOTA: MeteredQuotaConfig = { name: "rpc", actorMax: 300, orgMax: 1200 };

// A JSON-RPC request is small; sendTransaction payloads top out well under
// this. Bounding the body keeps a single request from buffering arbitrary
// bytes before validation runs.
const MAX_BODY_BYTES = 1024 * 1024;

const rpc = new Hono<{ Bindings: Env }>();

rpc.use("*", unifiedAuthMiddleware());
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

// The quota sits after the permission gate: callers the route would reject
// must not be able to charge the org-wide pool and starve authorized users.
rpc.post(
  "/proxy",
  requirePermissions("tokens:write"),
  validateBody(rpcRelayPayloadSchema),
  // A batch of N is N node calls charged as N, so the ceiling means what it
  // says regardless of how requests are packed.
  meteredQuota({
    ...RPC_QUOTA,
    units: (c) => {
      const payload = (c.req as unknown as { valid: (t: "json") => unknown }).valid("json");
      return Array.isArray(payload) ? payload.length : 1;
    },
  }),
  relayRpcRequest
);

export default rpc;
