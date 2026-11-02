/** Dashboard custody helpers. Registered only on the internal document. */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  credentialLifecycleSchema,
  credentialRotationSchema,
  custodyCompletionSchema,
  custodyConnectionsSchema,
  custodySetupProvidersSchema,
  custodySubmissionSchema,
  fireblocksCsrSchema,
  fireblocksDestinationSchema,
  fireblocksVaultPageSchema,
  installationConnectionSchema,
  safeCredentialSchema,
  walletFaucetResponseSchema,
} from "@/openapi/schemas/custody-setup";
import { walletFaucetSchema, walletIdParamsSchema } from "@/routes/custody/schemas";
import {
  createFireblocksCsrSchema,
  discoverFireblocksVaultsSchema,
} from "@/routes/internal-custody/fireblocks/schemas";
import { connectionParamsSchema, credentialParamsSchema } from "@/routes/internal-custody/schemas";
import { fireblocksDestinationQuerySchema } from "@/routes/internal-fireblocks/schemas";
import { byokRegistrationSchema } from "@/services/custody/byok-credential";
import { custodyCredentialSetupSchema } from "@/services/provider-setup-registry";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

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
  key?: "required" | "csr";
}
const base = "/internal/dashboard/custody";
const credentialResult = z.strictObject({ providerCredential: safeCredentialSchema });
const connectionResult = z.strictObject({ connection: installationConnectionSchema });
const humanProject =
  "Requires a Clerk member session with wallets.configure and an explicitly selected project; API keys cannot call this route. Only safe credential metadata is returned.";
export function registerCustodySetupPaths(registry: OpenAPIRegistry) {
  const routes: Route[] = [
    {
      method: "get",
      path: `${base}/providers`,
      operationId: "listCustodySetupProviders",
      summary: "Read dashboard custody setup status",
      description:
        "Reports each provider's legacy config, actual signing target type, and connection lifecycle counts. Reads existing records without initializing wallets or credentials. " +
        humanProject,
      data: custodySetupProvidersSchema,
    },
    {
      method: "get",
      path: `${base}/connections`,
      operationId: "listCustodySetupConnections",
      summary: "List dashboard custody connections",
      description:
        "Lists safe connection metadata newest first. The server defaults limit to 20, truncates and clamps it to 1-50, and clamps offset to 0-MAX_SAFE_INTEGER. An optional canonical provider filter is applied before counting and slicing. isRuntimeExecutionAllowed remains separate from connection lifecycle. " +
        humanProject,
      query: z.object({
        limit: z.number().optional(),
        offset: z.number().optional(),
        provider: z.enum(CUSTODY_PROVIDERS).optional(),
      }),
      data: custodyConnectionsSchema,
    },
    {
      method: "get",
      path: `${base}/connections/{connectionId}`,
      operationId: "getCustodySetupConnection",
      summary: "Read a custody installation",
      description:
        "Reads lifecycle, projected completion, and canComplete/canReplaceCredentials/canCancel decisions. Never auto-completes setup. " +
        humanProject,
      params: connectionParamsSchema,
      data: connectionResult,
    },
    {
      method: "get",
      path: `${base}/connections/{connectionId}/provider-credential/lifecycle`,
      operationId: "getCustodySetupCredentialLifecycle",
      summary: "Read a connection's credential lifecycle",
      description:
        "Returns safe current credential metadata, optional rotation candidate, affected project/connection references, and nullable retained rollback target with expiry. " +
        humanProject,
      params: connectionParamsSchema,
      data: credentialLifecycleSchema,
    },
    {
      method: "post",
      path: `${base}/provider-credentials`,
      operationId: "submitCustodySetupCredentials",
      summary: "Submit custody setup credentials",
      description:
        "Stores an explicit Privy or Fireblocks registration as a project-scoped pending installation. fields must include credentialLabel and scope: project. Fireblocks accepts a server-created signingKeyId, never a raw private key; optional selected vault IDs must be distinct and include the signing vault. Idempotency-Key is required and fingerprinted by the service. Submission does not imply completed installation. " +
        humanProject,
      key: "required",
      body: custodyCredentialSetupSchema,
      data: custodySubmissionSchema,
      status: 201,
    },
    {
      method: "post",
      path: `${base}/connections/{connectionId}/provider-credentials`,
      operationId: "replaceCustodySetupCredentials",
      summary: "Replace pending installation credentials",
      description:
        "Replaces credentials only when this connection's current installation state permits it. Uses the same provider-specific payload as submission and a required caller-chosen idempotency key. Does not rotate an already-active credential. " +
        humanProject,
      params: connectionParamsSchema,
      key: "required",
      body: custodyCredentialSetupSchema,
      data: custodySubmissionSchema,
      status: 201,
    },
    {
      method: "post",
      path: `${base}/connections/{connectionId}/complete-installation`,
      operationId: "completeCustodySetupConnection",
      summary: "Complete a custody installation",
      description:
        "Explicitly runs provider validation and any required wallet import. Returns success, failed, or retry_unknown completion state without exposing secrets. Each invocation performs one API action; inspect the result before any further request. " +
        humanProject,
      params: connectionParamsSchema,
      data: custodyCompletionSchema,
    },
    {
      method: "post",
      path: `${base}/connections/{connectionId}/cancel-installation`,
      operationId: "cancelCustodySetupConnection",
      summary: "Cancel a pending custody installation",
      description:
        "Cancels an installation only in a permitted state. Returns the projected connection, including its current lifecycle decisions. Does not deactivate a separate active credential. " +
        humanProject,
      params: connectionParamsSchema,
      data: connectionResult,
    },
    {
      method: "post",
      path: `${base}/connections/{connectionId}/deactivate`,
      operationId: "deactivateCustodySetupConnection",
      summary: "Deactivate a custody connection",
      description:
        "Explicitly deactivates a connection subject to access, lifecycle and wallet/runtime constraints. Does not automatically deactivate the shared provider credential. Returns custodyConnection rather than connection. Recovery quota applies. " +
        humanProject,
      params: connectionParamsSchema,
      data: z.strictObject({ custodyConnection: installationConnectionSchema }),
    },
    {
      method: "post",
      path: `${base}/provider-credentials/{credentialId}/rotate`,
      operationId: "rotateCustodySetupCredential",
      summary: "Rotate a custody provider credential",
      description:
        "Creates and validates a linked rotation candidate with a required Idempotency-Key. The provider must match the current credential, and fields contain only provider registration fields, without setup labels or scope. The API enforces account fingerprint, authorization across references, and rotation quotas. " +
        humanProject,
      params: credentialParamsSchema,
      key: "required",
      body: byokRegistrationSchema,
      data: credentialRotationSchema,
    },
    {
      method: "post",
      path: `${base}/provider-credentials/{credentialId}/complete-rotation`,
      operationId: "completeCustodySetupCredentialRotation",
      summary: "Complete a pending credential rotation",
      description:
        "Explicitly resumes provider validation of the candidate named by credentialId. Preserves failed or retry_unknown results; never generates replacement registration fields or automatically rolls back. Rotation quota applies. " +
        humanProject,
      params: credentialParamsSchema,
      data: credentialRotationSchema,
    },
    {
      method: "post",
      path: `${base}/provider-credentials/{credentialId}/rollback-rotation`,
      operationId: "rollbackCustodySetupCredential",
      summary: "Roll back a custody provider credential",
      description:
        "Explicitly restores an eligible retained predecessor after validating current references, provider identity, and rollback expiry. Uses the current credential ID, not an inferred candidate. Recovery quota applies. " +
        humanProject,
      params: credentialParamsSchema,
      data: credentialResult,
    },
    {
      method: "post",
      path: `${base}/provider-credentials/{credentialId}/deactivate`,
      operationId: "deactivateCustodySetupCredential",
      summary: "Deactivate a custody provider credential",
      description:
        "Explicitly deactivates an eligible credential and retires secret material. The API refuses credentials still in use or in an incompatible lifecycle state. Recovery quota applies. " +
        humanProject,
      params: credentialParamsSchema,
      data: credentialResult,
    },
    {
      method: "get",
      path: `${base}/fireblocks/csr`,
      operationId: "getCustodyFireblocksCsr",
      summary: "Read a pending Fireblocks CSR",
      description:
        "Reads the public certificate signing request or null. The private key stays on the API. " +
        humanProject,
      data: z.strictObject({ csr: fireblocksCsrSchema.nullable() }),
    },
    {
      method: "post",
      path: `${base}/fireblocks/csr`,
      operationId: "createCustodyFireblocksCsr",
      summary: "Create a Fireblocks registration CSR",
      description:
        "Creates the registration key on the API and returns only its public CSR, ID, and expiry. Requires an explicit empty JSON object and Idempotency-Key. External workspace registration/approval remains an operator step. " +
        humanProject,
      key: "csr",
      body: createFireblocksCsrSchema,
      data: z.strictObject({ csr: fireblocksCsrSchema }),
      status: 201,
    },
    {
      method: "post",
      path: `${base}/fireblocks/vaults/discover`,
      operationId: "discoverCustodyFireblocksVaults",
      summary: "Discover Fireblocks registration vaults",
      description:
        "Uses the server-held signingKeyId and supplied API user ID to read one vault page without exposing private keys or signing a transaction. Optional after is an opaque cursor, and namePrefix narrows discovery. Inputs are POSTed to avoid credential identifiers in URLs. Discovery quota applies. " +
        humanProject,
      body: discoverFireblocksVaultsSchema,
      data: fireblocksVaultPageSchema,
    },
    {
      method: "post",
      path: "/internal/dashboard/wallets/{walletId}/faucet",
      operationId: "requestDashboardWalletFaucet",
      summary: "Request a dashboard devnet wallet airdrop",
      description:
        "Requires a Clerk session, selected project, and wallets.execute. Requests the server-selected devnet airdrop amount for the exact custody wallet, with authorization and faucet quota enforced by the API. Body must be an empty object. confirmed, failed, and timeout observations are returned unchanged; no automatic follow-up or retry is implied.",
      params: walletIdParamsSchema,
      body: walletFaucetSchema,
      data: walletFaucetResponseSchema,
    },
    {
      method: "get",
      path: "/internal/dashboard/fireblocks/destination-eligibility",
      operationId: "getDashboardFireblocksDestination",
      summary: "Check a Fireblocks destination's whitelist state",
      description:
        "Requires a Clerk session, selected project, wallets.read and counterparties.read. Checks the exact custody wallet, counterparty, account, address, and token against the Fireblocks address book. Returns approved, pending, or not_whitelisted for the resolved asset. Does not transfer funds, approve an entry, or poll. Destination quota applies.",
      query: fireblocksDestinationQuerySchema,
      data: fireblocksDestinationSchema,
    },
  ];
  for (const route of routes)
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      tags: ["Dashboard Custody Setup"],
      summary: route.summary,
      description: route.description,
      security: [{ clerkBearerAuth: [] }],
      request: {
        headers:
          route.key === "csr"
            ? projectScopeWithDeclaredIdempotencyHeaders({ key: "required", serverErrors: "rerun" })
            : route.key === "required"
              ? projectScopeWithRequiredIdempotencyHeaders
              : projectScopeHeaders,
        params: route.params,
        query: route.query,
        ...(route.body === undefined
          ? {}
          : { body: { required: true, content: jsonContent(route.body) } }),
      },
      responses: {
        [route.status ?? 200]: {
          description: route.summary,
          content: jsonContent(successResponseSchema(route.data).strict()),
        },
        ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 429, 500, 503]),
      },
    });
}
