import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  operationResponseSchema,
  operationsPageSchema,
  refreshOperationSchema,
  submitOperationSchema,
} from "@sdp/types/operations";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  emptyOperationBodySchema,
  operationIdParamsSchema,
  operationsListQuerySchema,
} from "@/routes/operations/schemas";
import { earnErrorResponses } from "./earn-errors";
import {
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";

/** Internal lifecycle contract; publication requires a separate security sign-off. */
export function registerOperationsPaths(registry: OpenAPIRegistry) {
  const security: Array<Record<string, string[]>> = [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
  const common = { tags: ["Operations"], security };
  const response = successResponseSchema(operationResponseSchema);
  registry.registerPath({
    ...common,
    method: "get",
    path: "/v1/operations",
    operationId: "listOperations",
    summary: "List operations",
    description:
      "Lists operation history in the exact authenticated project and environment. The default feed contains visible project custody wallets. Wallet history requires an explicit ownerAddress; choose ownerAddress or walletId. Filters apply before cursor pagination. Requires earn.read for the initially supported Earn operation kinds. Reading never starts execution.",
    request: { headers: projectScopeHeaders, query: operationsListQuerySchema },
    responses: {
      200: {
        description: "One operation page",
        content: jsonContent(successResponseSchema(operationsPageSchema)),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });
  registry.registerPath({
    ...common,
    method: "get",
    path: "/v1/operations/{operationId}",
    operationId: "getOperation",
    summary: "Get an operation",
    description:
      "Returns current terms, the exact actionId/version, nextAction and authoritative settlement projection. Poll this route after execution or reload. nextAction refresh requests a fresh review only after SDP proves the prior action cannot execute; wait retains the same unresolved attempt. queued, awaiting_approval, submitted and settling are nonterminal. completed means verified delivery; cancelled means a verified cancellation outcome. cancelRequestedAt alone is pending intent. result fields stay null until their authoritative source is known. Requires earn.read and source visibility.",
    request: { headers: projectScopeHeaders, params: operationIdParamsSchema },
    responses: {
      200: { description: "Current operation", content: jsonContent(response) },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });
  for (const action of ["submit", "refresh", "cancel"] as const) {
    const descriptions = {
      submit:
        "Submits the exact reviewed transaction for asynchronous processing. Pass actionId and version. Route selection and transaction preparation never happen here. Wallets also supply signedTransaction, verified against the stored message and required signers. The request durably records authorization and returns 202; a worker performs every signature, custody proposal and broadcast, including fast signers. Stale actions return 409. A late exact signature after cancellation is retained for observation and never authorizes a new broadcast. Requires earn.execute and the current action principal.",
      refresh:
        "Prepares a fresh reviewed action. Pass the current actionId and version. For nextAction select_option, also pass an optionId advertised in terms.options; this only prepares the selected transaction and never queues submission. Later refreshes preserve that selected route and fail if it is unavailable. Other replacements require proof the prior attempt cannot execute or its authoritative outcome is resolved. nextAction refresh advertises a proven refusal or expiry eligible for this action; unresolved attempts remain wait. An exposed owner sign_transaction action without registered signed bytes returns 409 CONFLICT with details.reason wallet_transaction_outcome_unknown because the owner may have independently signed and broadcast it. Old action IDs and signatures cannot approve the replacement. Signed or ambiguously dispatched attempts must be reconciled first; blockhash expiry or missing RPC history alone does not prove nonexecution. New terms require explicit submit. Requires earn.execute and fresh source admission.",
      cancel:
        "Durably requests cancellation and returns the current operation. An undispatched server-controlled preparation can cancel locally. An unsigned transaction already exposed to an owner cannot prove nonexecution, so cancellation stays pending. A worker requests account-bound provider cleanup or exposes a separately authorized onchain cancellation action. Cancellation acknowledgment, queue closure and payout are separate observations. Existing provider obligations and intermediate tokens remain visible until their outcome is verified. Requires earn.manage and current source authority.",
    };
    registry.registerPath({
      ...common,
      method: "post",
      path: `/v1/operations/{operationId}/${action}`,
      operationId: `${action}Operation`,
      summary: `${action[0]?.toUpperCase()}${action.slice(1)} an operation`,
      description: descriptions[action],
      request: {
        headers: projectScopeWithDeclaredIdempotencyHeaders({
          key: "required",
          serverErrors: "rerun",
        }),
        params: operationIdParamsSchema,
        body: {
          required: true,
          content: jsonContent(
            action === "submit"
              ? submitOperationSchema
              : action === "refresh"
                ? refreshOperationSchema
                : emptyOperationBodySchema
          ),
        },
      },
      responses: {
        ...(action === "submit"
          ? {}
          : { 200: { description: "Already terminal operation", content: jsonContent(response) } }),
        202: {
          description: "Current operation; asynchronous work remains",
          content: jsonContent(response),
        },
        ...earnErrorResponses([400, 401, 403, 404, 409, 422, 429, 500, 501, 503]),
      },
    });
  }
}
