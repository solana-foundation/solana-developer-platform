import { Hono } from "hono";
import { z } from "zod";
import { badRequest, badRequestParams } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { rpcAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import {
  createRingsConnection,
  deactivateRingsConnection,
  listRingsConnections,
  makeDefaultRingsConnection,
  testRingsConnection,
} from "@/services/helius-rings/connection.service";
import type { Env } from "@/types/env";

const connectionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  solanaRpcUrl: z.string().trim().url().max(2048),
  indexerUrl: z.string().trim().url().max(2048),
  proverUrl: z.string().trim().url().max(2048),
  ringRpcUrl: z.string().trim().url().max(2048).optional(),
  allowInsecureHttp: z.boolean().default(false),
});
const connectionParamsSchema = z.strictObject({ connectionId: z.string().trim().min(1) });

const routes = new Hono<{ Bindings: Env }>();
routes.use("*", rpcAdminAuthMiddleware());
routes.use("*", projectContextMiddleware());

routes.get("/connections", async (c) => success(c, await listRingsConnections(c)));

routes.post("/connections", async (c) => {
  const parsed = connectionInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }
  return created(c, await createRingsConnection(c, parsed.data));
});

routes.post("/connections/:connectionId/test", async (c) => {
  const params = parseParams(c.req.param());
  return success(c, await testRingsConnection(c, params.connectionId));
});

routes.post("/connections/:connectionId/make-default", async (c) => {
  const params = parseParams(c.req.param());
  return success(c, await makeDefaultRingsConnection(c, params.connectionId));
});

routes.post("/connections/:connectionId/deactivate", async (c) => {
  const params = parseParams(c.req.param());
  return success(c, await deactivateRingsConnection(c, params.connectionId));
});

function parseParams(value: unknown) {
  const parsed = connectionParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequestParams({ errors: z.flattenError(parsed.error).fieldErrors });
  }
  return parsed.data;
}

export default routes;
