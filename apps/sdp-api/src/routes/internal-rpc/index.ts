import { BYOK_RPC_PROVIDERS } from "@sdp/rpc/byok";
import { RPC_CONNECTION_NETWORKS } from "@sdp/types";
import { Hono } from "hono";
import { z } from "zod";
import { badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { rpcAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import {
  activateRpcConnection,
  deactivateRpcConnection,
  listRpcConnections,
  submitRpcConnection,
} from "@/services/rpc-connection.service";
import type { Env } from "@/types/env";

const connectionParamsSchema = z.object({ connectionId: z.string().trim().min(1) }).strict();

const listQuerySchema = z
  .object({
    scope: z.enum(["organization", "project"]).default("organization"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict();

/**
 * The endpoint is supplied by the tenant, not derived from a built-in vendor
 * URL — see `@sdp/rpc/byok`. `apiKey` is write-only: it goes to
 * CredentialSecretStore and is never returned by any route here.
 */
const createConnectionSchema = z
  .object({
    provider: z.enum(BYOK_RPC_PROVIDERS as unknown as [string, ...string[]]),
    network: z.enum(RPC_CONNECTION_NETWORKS as unknown as [string, ...string[]]),
    scope: z.enum(["organization", "project"]).default("organization"),
    credentialLabel: z.string().trim().min(1).max(100),
    endpointUrl: z.string().trim().url().max(2048),
    apiKey: z.string().min(1).max(4096),
  })
  .strict();

const activateSchema = z
  .object({ makeDefault: z.boolean().default(true) })
  .strict()
  .default({ makeDefault: true });

const internalRpc = new Hono<{ Bindings: Env }>();

internalRpc.use("*", rpcAdminAuthMiddleware());
internalRpc.use("*", projectContextMiddleware());

internalRpc.get("/connections", async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  return success(c, await listRpcConnections(c, parsed.data));
});

internalRpc.post("/connections", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return created(
    c,
    await submitRpcConnection(c, parsed.data as Parameters<typeof submitRpcConnection>[1])
  );
});

internalRpc.post("/connections/:connectionId/activate", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  const body = await c.req.json().catch(() => undefined);
  const parsed = activateSchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return success(c, await activateRpcConnection(c, params.data.connectionId, parsed.data));
});

internalRpc.post("/connections/:connectionId/deactivate", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  return success(c, await deactivateRpcConnection(c, params.data.connectionId));
});

export default internalRpc;
