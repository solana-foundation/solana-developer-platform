import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  createRingsProjectRingBodySchema,
  createRingsWalletBodySchema,
  createRingsZoneBodySchema,
  errorResponseSchema,
  prepareRingsOperationBodySchema,
  retryRingsOperationBodySchema,
  ringsListLimitQuerySchema,
  ringsOperationIdParamSchema,
  ringsOperationSchema,
  ringsOperationSummarySchema,
  ringsProjectRingSchema,
  ringsRuntimeHealthSchema,
  ringsSyncResultSchema,
  ringsWalletIdentitySchema,
  ringsWalletIdParamSchema,
  ringsWalletSchema,
  ringsZoneSchema,
  successResponseSchema,
  z,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

const TAG = "Helius Rings";

/** The router accepts API keys, Clerk JWTs, and session cookies alike. */
const ringsSecurity: Array<Record<string, string[]>> = [
  { apiKeyAuth: [] },
  { clerkBearerAuth: [] },
  { sessionCookie: [] },
];

export function registerHeliusRingsPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/health",
    tags: [TAG],
    summary: "Probe the rings gateway health board",
    operationId: "getRingsHealth",
    description:
      "Per-component status (rpc, prover, photon, gateway). Every rings route answers 403 while the feature flag is off.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders },
    responses: {
      200: {
        description: "Component health board.",
        content: jsonContent(successResponseSchema(z.object({ health: ringsRuntimeHealthSchema }))),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/ring",
    tags: [TAG],
    summary: "Get the project's custom ring",
    operationId: "getRingsProjectRing",
    description: "404 while the project uses only the default public ring.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders },
    responses: {
      200: {
        description: "The recorded custom ring.",
        content: jsonContent(successResponseSchema(z.object({ ring: ringsProjectRingSchema }))),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/ring",
    tags: [TAG],
    summary: "Record the project's custom ring and run bring-up",
    operationId: "createRingsProjectRing",
    description:
      "Records the pre-deployed ring program id and completes bring-up through the gateway (signed through custody). Idempotent: re-submitting the same id resumes a pending or failed bring-up, and an already-active ring returns as it stands. A different id replaces a ring that never went active and is refused with 409 once active. 409 also covers a ring whose config authority custody cannot sign for.",
    security: ringsSecurity,
    request: {
      headers: projectScopeHeaders,
      body: { content: jsonContent(createRingsProjectRingBodySchema) },
    },
    responses: {
      201: {
        description: "The ring as recorded, active once bring-up completed.",
        content: jsonContent(successResponseSchema(z.object({ ring: ringsProjectRingSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/wallets",
    tags: [TAG],
    summary: "List the project's rings wallets",
    operationId: "listRingsWallets",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, query: ringsListLimitQuerySchema },
    responses: {
      200: {
        description: "Rings wallets, newest first.",
        content: jsonContent(
          successResponseSchema(z.object({ wallets: z.array(ringsWalletSchema) }))
        ),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/wallets",
    tags: [TAG],
    summary: "Create a rings wallet",
    operationId: "createRingsWallet",
    description:
      "Binds a rings wallet to an SDP custody wallet and provisions its shielded identity through the gateway. A gateway that refuses answers 503 and the wallet stays pending.",
    security: ringsSecurity,
    request: {
      headers: projectScopeHeaders,
      body: { content: jsonContent(createRingsWalletBodySchema) },
    },
    responses: {
      201: {
        description: "The created wallet.",
        content: jsonContent(successResponseSchema(z.object({ wallet: ringsWalletSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/wallets/{walletId}",
    tags: [TAG],
    summary: "Get a rings wallet",
    operationId: "getRingsWallet",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsWalletIdParamSchema },
    responses: {
      200: {
        description: "The wallet.",
        content: jsonContent(successResponseSchema(z.object({ wallet: ringsWalletSchema }))),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/wallets/{walletId}/sync",
    tags: [TAG],
    summary: "Sync a wallet's shielded balances from Photon",
    operationId: "syncRingsWallet",
    description:
      "Reads shielded balances and advances the wallet's recorded observation point. Amounts stay decimal strings: they are uint64 on the wire and a JSON number would silently round anything past 2^53.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsWalletIdParamSchema },
    responses: {
      200: {
        description: "Balances as Photon reports them.",
        content: jsonContent(successResponseSchema(ringsSyncResultSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/wallets/{walletId}/identity",
    tags: [TAG],
    summary: "Read the wallet owner's registry identity",
    operationId: "getRingsWalletIdentity",
    description:
      "What the registry publishes for this wallet's owner, next to what this tenant derives. Answers even for a wallet with no shielded address, which is the case it exists for.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsWalletIdParamSchema },
    responses: {
      200: {
        description: "Published and derived identity, with any mismatch named.",
        content: jsonContent(
          successResponseSchema(z.object({ identity: ringsWalletIdentitySchema }))
        ),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/wallets/{walletId}/zones",
    tags: [TAG],
    summary: "List a wallet's zones",
    operationId: "listRingsZones",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsWalletIdParamSchema },
    responses: {
      200: {
        description: "Zones.",
        content: jsonContent(successResponseSchema(z.object({ zones: z.array(ringsZoneSchema) }))),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/wallets/{walletId}/zones",
    tags: [TAG],
    summary: "Create a zone",
    operationId: "createRingsZone",
    description: "Idempotent per (wallet, name).",
    security: ringsSecurity,
    request: {
      headers: projectScopeHeaders,
      params: ringsWalletIdParamSchema,
      body: { content: jsonContent(createRingsZoneBodySchema) },
    },
    responses: {
      201: {
        description: "The zone.",
        content: jsonContent(successResponseSchema(z.object({ zone: ringsZoneSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/operations",
    tags: [TAG],
    summary: "List the project's rings operations",
    operationId: "listRingsOperations",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, query: ringsListLimitQuerySchema },
    responses: {
      200: {
        description: "Operations, newest first.",
        content: jsonContent(
          successResponseSchema(z.object({ operations: z.array(ringsOperationSummarySchema) }))
        ),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/operations",
    tags: [TAG],
    summary: "Prepare a rings operation",
    operationId: "prepareRingsOperation",
    description:
      'Reserves the intent and advances through policy. Idempotent per (wallet, op, canonical input, clientNonce): the same request returns the operation it already reserved. The symbolic ring selector is resolved and pinned to a program id at prepare time; `ring: "custom"` is refused until the project\'s ring is active.',
    security: ringsSecurity,
    request: {
      headers: projectScopeHeaders,
      body: { content: jsonContent(prepareRingsOperationBodySchema) },
    },
    responses: {
      201: {
        description: "The prepared operation.",
        content: jsonContent(successResponseSchema(z.object({ operation: ringsOperationSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/helius-rings/operations/{operationId}",
    tags: [TAG],
    summary: "Get a rings operation",
    operationId: "getRingsOperation",
    description: "Full detail with the event timeline, for polling state transitions.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsOperationIdParamSchema },
    responses: {
      200: {
        description: "The operation.",
        content: jsonContent(successResponseSchema(z.object({ operation: ringsOperationSchema }))),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/operations/{operationId}/execute",
    tags: [TAG],
    summary: "Advance a waiting rings operation",
    operationId: "executeRingsOperation",
    description:
      "Acts on approval_required, submitted, and indexing states; any other state returns the operation unchanged.",
    security: ringsSecurity,
    request: { headers: projectScopeHeaders, params: ringsOperationIdParamSchema },
    responses: {
      200: {
        description: "The operation after the attempt.",
        content: jsonContent(successResponseSchema(z.object({ operation: ringsOperationSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/helius-rings/operations/{operationId}/retry",
    tags: [TAG],
    summary: "Retry a failed rings operation",
    operationId: "retryRingsOperation",
    description:
      "Files a linked retry of a failed operation under a new clientNonce. Retry chains are capped; past the cap the operator must inspect the failure.",
    security: ringsSecurity,
    request: {
      headers: projectScopeHeaders,
      params: ringsOperationIdParamSchema,
      body: { content: jsonContent(retryRingsOperationBodySchema) },
    },
    responses: {
      201: {
        description: "The retry operation.",
        content: jsonContent(successResponseSchema(z.object({ operation: ringsOperationSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });
}
