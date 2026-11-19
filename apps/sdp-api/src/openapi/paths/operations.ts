import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  operationResponseSchema,
  operationsPageSchema,
  refreshOperationSchema,
  submitOperationSchema,
} from "@sdp/types/operations";
import { successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
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
      "Lists operation history in the exact authenticated project and environment. Pass ownerAddress to list your wallet's operations; no SDP wallet registration is required. Use walletId instead for an existing connected wallet. With neither filter, the feed contains visible connected-wallet operations. Filters apply before cursor pagination. Requires earn.read for the initially supported Earn operation kinds. Reading never starts execution.",
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
      "Returns current terms, the exact actionId/version, nextAction and authoritative settlement projection. Poll this route after submission or reload. nextAction sign_transaction asks your wallet to sign the supplied transaction before calling submit. sign_in_provider only applies when an explicitly selected connected wallet requires signing in its provider; follow its instructions and keep polling without submitting again. nextAction refresh rebuilds an unsigned preparation only before submission is accepted; wait retains the same unresolved attempt. queued, awaiting_signature, submitted and settling are nonterminal. completed means verified delivery; cancelled means a verified cancellation outcome. canCancel states whether this preparation can still be cancelled; earn.manage is also required. cancelRequestedAt alone is pending intent. result fields stay null until their authoritative source is known. Requires earn.read and source visibility.",
    request: { headers: projectScopeHeaders, params: operationIdParamsSchema },
    responses: {
      200: { description: "Current operation", content: jsonContent(response) },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });
  for (const action of ["submit", "refresh", "cancel"] as const) {
    const descriptions = {
      submit:
        "Submits the exact reviewed transaction for asynchronous processing. Pass actionId and version. Route selection and transaction preparation never happen here. For source.ownerAddress, supply signedTransaction as base64 after signing the prepared transaction in your own wallet; no SDP wallet or provider connection is needed. SDP verifies the exact stored message and required signatures. For source.walletId, omit signedTransaction; the worker requests signing through that connected wallet's configured provider. The request durably records authorization and returns 202. A worker broadcasts and tracks the transaction asynchronously. Provider signing may return sign_in_provider instructions; it never requires a second submit. Stale actions return 409. Requires earn.execute and the current action principal.",
      refresh:
        "Rebuilds an unsigned transaction and its terms before submission is accepted. It never signs, broadcasts or cancels a transaction. Pass the current actionId and version. For nextAction select_option, also pass an optionId advertised in terms.options; the selected route remains fixed on later refreshes. Review the new action/version and sign it before submit. After any POST /v1/operations/{operationId}/submit acceptance, new refresh requests return 409 CONFLICT with details.reason operation_already_submitted, including definitive failure; track that operation to its outcome, and start a new deposit or withdrawal only after a known failure. An exposed owner transaction without a known outcome returns 409 with details.reason wallet_transaction_outcome_unknown because SDP cannot invalidate bytes held by the caller. Timeout, blockhash expiry and missing RPC history alone never authorize replacement. An exact Idempotency-Key replay returns its original response without rebuilding; GET returns the current operation state. Requires earn.execute and fresh source admission.",
      cancel:
        "Cancels a preparation only before any submission has been accepted. After POST /v1/operations/{operationId}/submit is accepted, new cancellation requests return 409 CONFLICT with details.reason operation_already_submitted, including while queued or waiting for a provider signature. It never cancels an onchain transaction, revokes a signature or cancels a previously submitted queued withdrawal. An owner-address transaction already exposed for signing returns 409 with details.reason wallet_transaction_outcome_unknown because SDP cannot invalidate bytes held by the caller. Closing your own wallet signing prompt needs no API cancellation. A successful cancellation marks only an undispatched preparation cancelled. Requires earn.manage and current source authority.",
    };
    registry.registerPath({
      ...common,
      method: "post",
      path: `/v1/operations/{operationId}/${action}`,
      operationId: `${action}Operation`,
      summary:
        action === "cancel"
          ? "Cancel a preparation"
          : `${action[0]?.toUpperCase()}${action.slice(1)} an operation`,
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
            withOpenApi(
              action === "submit"
                ? submitOperationSchema
                : action === "refresh"
                  ? refreshOperationSchema
                  : emptyOperationBodySchema,
              {
                example:
                  action === "submit"
                    ? {
                        actionId: "opact_example",
                        version: 1,
                        signedTransaction: "<base64-signed-transaction>",
                      }
                    : action === "refresh"
                      ? { actionId: "opact_example", version: 1 }
                      : {},
              }
            )
          ),
        },
      },
      responses: {
        ...(action === "cancel"
          ? {
              200: { description: "Cancelled preparation", content: jsonContent(response) },
            }
          : {
              202: {
                description:
                  action === "refresh"
                    ? "Rebuilt preparation; review the returned transaction"
                    : "Submission accepted; poll the operation for progress",
                content: jsonContent(response),
              },
            }),
        ...earnErrorResponses([400, 401, 403, 404, 409, 422, 429, 500, 501, 503]),
      },
    });
  }
}
