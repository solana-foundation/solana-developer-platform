import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, badRequestParams } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { credentialAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { idempotencyKeyMiddleware } from "@/middleware/idempotency-key";
import { projectContextMiddleware } from "@/middleware/project-context";
import { getCustodySetupStatus } from "@/services/custody-setup-status.service";
import { getProviderCredentialInstallation } from "@/services/provider-credential-installation.service";
import { getProviderSetupDefinition } from "@/services/provider-setup-registry";
import {
  getPendingWalletLabel,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const connectionParamsSchema = z.object({ connectionId: z.string().trim().min(1) }).strict();
const privySetup = getProviderSetupDefinition("custody", "privy");

const internalCustody = new Hono<{ Bindings: Env }>();

internalCustody.use("*", credentialAdminAuthMiddleware());
internalCustody.use("*", projectContextMiddleware());
internalCustody.use("*", idempotencyKeyMiddleware());

// Reload-safe view of setup: which connections exist for this project, where
// each sits in its lifecycle, and the safe credential columns. This is what
// lets the dashboard resume a pending or failed install without ever asking
// for the secret again. Bounded, newest first; never secret material.
internalCustody.get("/connections", async (c) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit") ?? 20) || 20), 1), 50);
  // `|| 0` catches NaN but not Infinity, and a finite value past
  // MAX_SAFE_INTEGER would still overflow the bigint the SQL OFFSET binds to,
  // so finite offsets are clamped on both ends.
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const offset = Number.isFinite(rawOffset)
    ? Math.min(Math.max(Math.trunc(rawOffset), 0), Number.MAX_SAFE_INTEGER)
    : 0;

  const store = new ProviderCredentialStore(getDb(c.env));
  const { connections, total } = await store.listProjectConnectionsPage(
    auth.organizationId,
    projectId,
    { limit, offset }
  );

  return success(c, {
    connections: connections.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
      lastCheck: row.last_check_status
        ? {
            status: row.last_check_status,
            at: row.last_check_at,
            failureCode: row.last_check_failure_code,
          }
        : null,
      pendingWalletLabel: getPendingWalletLabel(row.setup_metadata) ?? null,
      providerCredential: {
        id: row.credential_id,
        label: row.credential_label,
        status: row.credential_status,
      },
    })),
    pagination: { limit, offset, total },
  });
});

// What is installed per provider for this scope: legacy config presence, the
// record that actually backs signing, and connection lifecycle counts. Internal
// on purpose — it drives dashboard setup flows only, so it commits to no public
// OpenAPI or API-key authorization contract while the setup model evolves.
internalCustody.get("/providers", async (c) => {
  const auth = getAuth(c);
  return success(
    c,
    await getCustodySetupStatus(getDb(c.env), auth.organizationId, c.get("projectId"))
  );
});

internalCustody.post("/provider-credentials", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = privySetup.validateSetupPayload(body, "submit");
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key is required");
  }

  const result = await privySetup.storeCredentials({
    context: c,
    payload: parsed.data,
    idempotencyKey,
  });
  return created(c, result);
});

internalCustody.post("/connections/:connectionId/provider-credentials", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }

  const body = await c.req.json().catch(() => null);
  const parsed = privySetup.validateSetupPayload(body, "replace");
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key is required");
  }

  return created(
    c,
    await privySetup.storeCredentials({
      context: c,
      connectionId: params.data.connectionId,
      payload: parsed.data,
      idempotencyKey,
    })
  );
});

internalCustody.get("/connections/:connectionId", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }
  return success(c, await getProviderCredentialInstallation(c, params.data.connectionId));
});

internalCustody.post("/connections/:connectionId/complete", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }
  return success(
    c,
    await privySetup.activate({ context: c, connectionId: params.data.connectionId })
  );
});

internalCustody.post("/connections/:connectionId/cancel", async (c) => {
  const params = connectionParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({ errors: z.flattenError(params.error).fieldErrors });
  }
  return success(
    c,
    await privySetup.deactivate({ context: c, connectionId: params.data.connectionId })
  );
});

export default internalCustody;
