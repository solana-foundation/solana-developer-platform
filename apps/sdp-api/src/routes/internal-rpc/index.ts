import { BYOK_RPC_PROVIDERS } from "@sdp/rpc/byok";
import { Hono } from "hono";
import { z } from "zod";
import { badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { rpcAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import {
  activateRpcConnection,
  deactivateRpcConnection,
  deleteRpcConnection,
  getRpcCredentialMode,
  listRpcConnections,
  rotateRpcConnection,
  setRpcCredentialMode,
  setServingRpcProvider,
  submitRpcConnection,
  testRpcConnection,
} from "@/services/rpc-connection.service";
import type { Env } from "@/types/env";

const connectionParamsSchema = z.strictObject({ connectionId: z.string().trim().min(1) });

// `organization` stays readable so connections made before HOO-1226 are still
// listed and can be deactivated. Only creation is project-only.
const listQuerySchema = z.strictObject({
  scope: z.enum(["organization", "project"]).default("project"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/**
 * The endpoint is supplied by the tenant, not derived from a built-in vendor
 * URL — see `@sdp/rpc/byok`. `apiKey` is write-only: it goes to
 * CredentialSecretStore and is never returned by any route here.
 */
const createConnectionSchema = z.strictObject({
  provider: z.enum(BYOK_RPC_PROVIDERS as unknown as [string, ...string[]]),
  // No `network`: it comes from the project's environment (HOO-1221), so a
  // caller cannot name one that disagrees with the project it lands on.
  // One way to configure a connection (HOO-1226). Organization scope is not
  // accepted here any more; the relay stopped resolving it.
  scope: z.literal("project").default("project"),
  credentialLabel: z.string().trim().min(1).max(100),
  endpointUrl: z.string().trim().url().max(2048).optional(),
  apiKey: z.string().min(1).max(4096),
});

const credentialModeSchema = z.strictObject({ mode: z.enum(["managed", "byok"]) });

// `default` is SDP's own rail and never has a tenant key, so it is accepted
// here and simply stands down whatever is serving.
const servingProviderSchema = z.strictObject({
  provider: z.enum([...BYOK_RPC_PROVIDERS, "default"] as unknown as [string, ...string[]]),
});

// The label and the network stay as they were: this replaces a key, it does
// not reconfigure the connection.
const rotateConnectionSchema = z.strictObject({
  endpointUrl: z.string().trim().url().max(2048).optional(),
  apiKey: z.string().min(1).max(4096),
});

const activateSchema = z
  .strictObject({ makeDefault: z.boolean().default(true) })
  .default({ makeDefault: true });

const internalRpc = new Hono<{ Bindings: Env }>();

internalRpc.use("*", rpcAdminAuthMiddleware());
internalRpc.use("*", projectContextMiddleware());

// Whose credentials this organization runs on. Organization-wide, so it sits
// beside the connections rather than on one of them.
internalRpc.get("/credential-mode", async (c) => {
  return success(c, await getRpcCredentialMode(c));
});

internalRpc.put("/credential-mode", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = credentialModeSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return success(c, await setRpcCredentialMode(c, parsed.data.mode));
});

// Which provider answers this project. Paired with the organization's provider
// setting by the dashboard so that choosing a provider switches the credential
// too, rather than writing a setting the relay never reaches.
internalRpc.put("/serving-provider", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = servingProviderSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return success(c, await setServingRpcProvider(c, parsed.data.provider));
});

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

// Swap the key without a gap where the project routes nothing (HOO-1229).
internalRpc.post("/connections/:connectionId/rotate", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  const body = await c.req.json().catch(() => null);
  const parsed = rotateConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return success(c, await rotateRpcConnection(c, params.data.connectionId, parsed.data));
});

// Checks the stored credential and writes nothing (HOO-1228).
internalRpc.post("/connections/:connectionId/test", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  return success(c, await testRpcConnection(c, params.data.connectionId));
});

internalRpc.delete("/connections/:connectionId", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  await deleteRpcConnection(c, params.data.connectionId);
  return success(c, { deleted: true });
});

export default internalRpc;
