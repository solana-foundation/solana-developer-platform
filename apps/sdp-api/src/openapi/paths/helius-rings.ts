/** Existing mounted operations. Registered only on the internal document. */
import type { OpenAPIRegistry, RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  projectRingSchema,
  ringsConnectionSchema,
  ringsConnectionTestSchema,
  ringsHealthSchema,
  ringsIdentitySchema,
  ringsOperationSchema,
  ringsOperationSummarySchema,
  ringsSetupSchema,
  ringsSyncSchema,
  ringsWalletSchema,
  ringsZoneSchema,
} from "@/openapi/schemas/helius-rings";
import {
  createProjectRingSchema,
  createRingsWalletSchema,
  createRingsZoneSchema,
  listLimitSchema,
  prepareRingsOperationSchema,
  rekeyRingsWalletSchema,
  retryRingsOperationSchema,
  voidRingsOperationSchema,
} from "@/routes/helius-rings/schemas";
import {
  connectionInputSchema,
  connectionParamsSchema,
} from "@/routes/internal-helius-rings/schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

interface Route {
  method: "get" | "post";
  path: string;
  operationId: string;
  summary: string;
  description: string;
  data: z.ZodType;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  status?: 200 | 201;
}
const walletParams = z.object({
  walletId: z
    .string()
    .min(1)
    .openapi({ description: "Rings wallet ID (hrw_), distinct from a custody wallet ID." }),
});
const operationParams = z.object({ operationId: z.string().min(1) });
const listQuery = z.object({ limit: listLimitSchema });
const operationData = z.object({ operation: ringsOperationSchema });
const walletData = z.object({ wallet: ringsWalletSchema });
const operationExecution =
  "May prove, request custody signatures, and submit transactions. The caller selects any subsequent action explicitly. No Idempotency-Key header is supported; operation creation and explicit retry carry a caller-supplied clientNonce in the body.";

export function registerHeliusRingsPaths(registry: OpenAPIRegistry) {
  const routes: Route[] = [
    {
      method: "get",
      path: "/health",
      operationId: "getHeliusRingsHealth",
      summary: "Read Helius Rings component health",
      description:
        "Returns the RPC, prover, and Photon status board. Amber or red observations are valid results, not proof of readiness.",
      data: z.object({ health: ringsHealthSchema }),
    },
    {
      method: "get",
      path: "/setup-status",
      operationId: "getHeliusRingsSetupStatus",
      summary: "Read Helius Rings setup status",
      description:
        "Reads whether the project has an active default connection, its safe display metadata, and whether this caller can administer connections. Does not expose endpoint credentials.",
      data: ringsSetupSchema,
    },
    {
      method: "get",
      path: "/rings",
      operationId: "listHeliusRingsProjectRings",
      summary: "List custom project rings",
      description:
        "Lists custom rings oldest first. An empty list means the project has only the default pool.",
      data: z.object({ rings: z.array(projectRingSchema) }),
    },
    {
      method: "post",
      path: "/rings/register-and-initialize",
      operationId: "createHeliusRingsProjectRing",
      summary: "Create or resume custom ring bring-up",
      description:
        "Records a lowercase ring slug and pre-deployed program ID, then runs signed bring-up through custody. Resubmitting the same name and program resumes failed bring-up. The default name is reserved. Operations may target the ring once active.",
      body: createProjectRingSchema,
      data: z.object({ ring: projectRingSchema }),
      status: 201,
    },
    {
      method: "get",
      path: "/wallets",
      operationId: "listHeliusRingsWallets",
      summary: "List Rings wallets",
      description:
        "Lists the project's Rings wallets newest first. Fetches at most limit rows (1-200); the server owns the default.",
      query: listQuery,
      data: z.object({ wallets: z.array(ringsWalletSchema) }),
    },
    {
      method: "post",
      path: "/wallets/provision-identity",
      operationId: "createHeliusRingsWallet",
      summary: "Create and provision a Rings wallet",
      description:
        "Binds a Rings wallet to a connected custody wallet selected by walletId, checks wallet scope, and provisions its shielded identity through the custody provider. Returned sdpWalletId is the provider identifier; subsequent wallet paths use the Rings wallet's id.",
      body: createRingsWalletSchema,
      data: walletData,
      status: 201,
    },
    {
      method: "get",
      path: "/wallets/{walletId}",
      operationId: "getHeliusRingsWallet",
      summary: "Read a Rings wallet",
      description: "Reads one authorized Rings wallet in the selected project.",
      params: walletParams,
      data: walletData,
    },
    {
      method: "post",
      path: "/wallets/{walletId}/sync",
      operationId: "syncHeliusRingsWallet",
      summary: "Sync a Rings wallet",
      description:
        "Performs a full Photon sync. The response's balances may be incomplete when degraded is true. Keeps balances separate by ring and preserves unknown decimals or prices as null or absent. This action writes observed wallet state and requires manage.",
      params: walletParams,
      data: ringsSyncSchema,
    },
    {
      method: "post",
      path: "/wallets/{walletId}/identity/rekey",
      operationId: "rekeyHeliusRingsWallet",
      summary: "Rekey a foreign Rings wallet identity",
      description:
        "Irreversibly rotates a foreign on-chain identity, abandoning funds encrypted to its old keys. confirmation must exactly match the wallet's name. The server verifies the mismatch; never inferred or performed as a follow-up to an identity read.",
      params: walletParams,
      body: rekeyRingsWalletSchema,
      data: walletData,
    },
    {
      method: "get",
      path: "/wallets/{walletId}/identity",
      operationId: "getHeliusRingsWalletIdentity",
      summary: "Inspect a Rings wallet identity",
      description:
        "Reads derived, published, and recorded shielded addresses and classifies an unregistered, matching, or foreign identity. Does not rotate keys or return private key material.",
      params: walletParams,
      data: z.object({ identity: ringsIdentitySchema }),
    },
    {
      method: "get",
      path: "/wallets/{walletId}/zones",
      operationId: "listHeliusRingsZones",
      summary: "List Rings wallet zones",
      description: "Lists SDP-owned metadata zones for this Rings wallet.",
      params: walletParams,
      data: z.object({ zones: z.array(ringsZoneSchema) }),
    },
    {
      method: "post",
      path: "/wallets/{walletId}/zones",
      operationId: "createHeliusRingsZone",
      summary: "Create a Rings wallet zone",
      description:
        "Creates SDP metadata without signing. Idempotent by wallet and zone name; no idempotency header is accepted.",
      params: walletParams,
      body: createRingsZoneSchema,
      data: z.object({ zone: ringsZoneSchema }),
      status: 201,
    },
    {
      method: "get",
      path: "/operations",
      operationId: "listHeliusRingsOperations",
      summary: "List Rings operation summaries",
      description:
        "Lists project operation summaries newest first, limited to 1-200 rows. Returns recorded failure, submission signature, and linked retry ID without fetching each operation or polling.",
      query: listQuery,
      data: z.object({ operations: z.array(ringsOperationSummarySchema) }),
    },
    {
      method: "post",
      path: "/operations/execute",
      operationId: "createHeliusRingsOperation",
      summary: "Create and run a Rings operation",
      description:
        "Reserves an intent and runs the pipeline immediately. Supports shield, withdraw, transfer_registered, merge, ring_exit, and ring_entry. amountRaw is a positive u64 base-unit integer string. Spends support only the runtime's SOL/USDC mints; merge has no amount, recipient, or ring; ring moves require a custom ring and SOL. Repeating an intent returns its existing row at its current state. " +
        operationExecution,
      body: prepareRingsOperationSchema.in,
      data: operationData,
      status: 201,
    },
    {
      method: "get",
      path: "/operations/{operationId}",
      operationId: "getHeliusRingsOperation",
      summary: "Read a Rings operation and timeline",
      description:
        "Reads the authorized operation and its event timeline. Submission does not prove Photon indexing. Proof artifacts are stripped by the API mapper and the consumed nonce is not retained.",
      params: operationParams,
      data: operationData,
    },
    {
      method: "post",
      path: "/operations/{operationId}/resume-execution",
      operationId: "executeHeliusRingsOperation",
      summary: "Resume a Rings operation",
      description:
        "Advances an operation left mid-pipeline after interruption. No request body is read. " +
        operationExecution,
      params: operationParams,
      data: operationData,
    },
    {
      method: "post",
      path: "/operations/{operationId}/retry",
      operationId: "retryHeliusRingsOperation",
      summary: "Create and run a linked Rings retry",
      description:
        "Creates a linked retry of a failed operation with an explicit clientNonce. The server pins the original ring and enforces retryability and depth. " +
        operationExecution,
      params: operationParams,
      body: retryRingsOperationSchema,
      data: operationData,
      status: 201,
    },
    {
      method: "post",
      path: "/operations/{operationId}/recheck",
      operationId: "recheckHeliusRingsOperation",
      summary: "Recheck a signed Rings failure",
      description:
        "Checks the indexer and can complete an operation it finds. Writes observed state and requires manage. Never proves absence and never voids or retries automatically. No body is read.",
      params: operationParams,
      data: operationData,
    },
    {
      method: "post",
      path: "/operations/{operationId}/void",
      operationId: "voidHeliusRingsOperation",
      summary: "Void an absent signed Rings failure",
      description:
        "An explicit irreversible reconciliation assertion naming the original signature. The server checks age, chain history, and absence before voiding. A recheck is a separate operator choice; this command never performs it automatically.",
      params: operationParams,
      body: voidRingsOperationSchema,
      data: operationData,
    },
  ];
  const connections: Route[] = [
    {
      method: "get",
      path: "/connections",
      operationId: "listHeliusRingsConnections",
      summary: "List Rings connections",
      description:
        "Lists safe endpoint origins and connection status for this project, with no stored URL credentials. Requires a Clerk session for an organization administrator with helius_rings.configure.",
      data: z.strictObject({ connections: z.array(ringsConnectionSchema) }),
    },
    {
      method: "post",
      path: "/connections",
      operationId: "createHeliusRingsConnection",
      summary: "Create a Rings connection",
      description:
        "Probes and stores keyed RPC, Photon, prover, and optional custom-ring RPC URLs. The first active connection becomes default. Returns only safe endpoint origins. Plain HTTP requires explicit allowInsecureHttp and a development API environment. Requires an organization administrator session with helius_rings.configure.",
      body: connectionInputSchema,
      data: ringsConnectionSchema,
      status: 201,
    },
    {
      method: "post",
      path: "/connections/{connectionId}/test",
      operationId: "testHeliusRingsConnection",
      summary: "Test a Rings connection",
      description:
        "Probes the selected stored connection without signing. Returns component health and optional custom-ring RPC health. Requires an organization administrator session with helius_rings.configure.",
      params: connectionParamsSchema,
      data: ringsConnectionTestSchema,
    },
    {
      method: "post",
      path: "/connections/{connectionId}/make-default",
      operationId: "makeDefaultHeliusRingsConnection",
      summary: "Make a Rings connection default",
      description:
        "Selects an active connection as this project's default. Requires an organization administrator session with helius_rings.configure.",
      params: connectionParamsSchema,
      data: ringsConnectionSchema,
    },
    {
      method: "post",
      path: "/connections/{connectionId}/deactivate",
      operationId: "deactivateHeliusRingsConnection",
      summary: "Deactivate a Rings connection",
      description:
        "Deactivates a non-default connection only after its pinned operations have settled or been voided. Choose another default explicitly first. Requires an organization administrator session with helius_rings.configure.",
      params: connectionParamsSchema,
      data: ringsConnectionSchema,
    },
  ];
  for (const [prefix, definitions, sessionOnly] of [
    ["/v1/helius-rings", routes, false],
    ["/internal/dashboard/helius-rings", connections, true],
  ] as const) {
    for (const route of definitions) {
      const request: NonNullable<RouteConfig["request"]> = {
        headers: projectScopeHeaders,
        params: route.params,
        query: route.query,
      };
      if (route.body !== undefined)
        request.body = { required: true, content: jsonContent(route.body) };
      registry.registerPath({
        method: route.method,
        path: prefix + route.path,
        operationId: route.operationId,
        tags: ["Helius Rings"],
        summary: route.summary,
        description: route.description,
        security: sessionOnly
          ? [{ clerkBearerAuth: [] }]
          : [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }],
        request,
        responses: {
          [route.status ?? 200]: {
            description: route.summary,
            content: jsonContent(
              sessionOnly
                ? successResponseSchema(route.data).strict()
                : successResponseSchema(route.data)
            ),
          },
          ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 503]),
        },
      });
    }
  }
}
