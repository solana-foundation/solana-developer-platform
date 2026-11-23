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
import { EARN_GROUPS } from "./earn-groups";
import {
  DOCS_GROUP,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";

/** Shared lifecycle contract; publication follows the owning module's release channel. */
export function registerOperationsPaths(registry: OpenAPIRegistry, publicOnly = false) {
  const security: Array<Record<string, string[]>> = publicOnly
    ? [{ apiKeyAuth: [] }]
    : [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
  // Operations track Earn's actions, so the reference nests them under Earn as their own group.
  const common = { tags: ["Earn"], [DOCS_GROUP]: EARN_GROUPS.operations, security };
  const response = successResponseSchema(operationResponseSchema);
  registry.registerPath({
    ...common,
    method: "get",
    path: "/v1/operations",
    operationId: "listOperations",
    summary: "List operations",
    description:
      "Lists deposits and withdrawals in the authenticated project and environment, newest first. Pass ownerAddress to list a wallet's operations; the wallet needs no registration in SDP. Without a filter, the list holds only SDP custody wallet operations, and walletId narrows it to one. status=active returns every operation not yet final, preparations included; an exact status returns only that state, and no status returns full history. kind=earn.deposit or kind=earn.withdraw returns one type. Every filter applies before cursor pagination. A returned operation can already show a newer final result than the status the filter matched. Requires earn.read. Reading never starts execution.",
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
      "Returns an operation's status, terms, current actionId and version, nextAction and settlement result. Poll it after submitting. Each nextAction type says what to do next: sign_transaction asks the owner to sign, select_option asks you to choose a route with refresh, and wait means keep polling the same attempt. queued, awaiting_signature, submitted and settling are in progress. For a queued withdrawal, submitted means its request is still confirming, and settling means the provider has yet to pay out. completed means verified delivery; for a selected recovery, result.settlementOutcome recovered means returned strategy shares, never withdrawal proceeds. cancelled means a verified cancellation. canCancel says whether the preparation can still be cancelled, which also needs earn.manage; cancelRequestedAt alone is pending intent. result fields stay null until their source is known. Requires earn.read and source visibility.",
    request: { headers: projectScopeHeaders, params: operationIdParamsSchema },
    responses: {
      200: { description: "Current operation", content: jsonContent(response) },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });
  for (const action of ["submit", "refresh", "cancel"] as const) {
    const descriptions = {
      submit:
        "Submits the reviewed transaction for asynchronous broadcast and returns 202. Pass the current actionId and version and, for an ownerAddress source, signedTransaction: the prepared transaction signed in the owner's wallet, base64-encoded. SDP verifies the exact stored message and required signatures and records the authorization; a worker then broadcasts and tracks the transaction, so poll GET /v1/operations/{operationId}. Stale actions return 409. Requires earn.execute and the current action principal. Before each new signing or broadcast effect, the worker rechecks the credential, execute permission, project membership and wallet binding; losing authority stops new effects but never proves a transaction did not execute. For an SDP custody wallet, omit signedTransaction: the worker requests the custody provider's signature, which can return sign_in_provider instructions but never needs a second submit.",
      refresh:
        "Prepares a new unsigned transaction and terms before submission; it never signs, broadcasts or cancels. Pass the current actionId and version, plus an optionId from terms.options when nextAction is select_option; the chosen route stays fixed on later refreshes. Review the returned action and sign it before submitting. After any accepted submit, refresh returns 409 CONFLICT with details.reason operation_already_submitted, even after a definitive failure: track that operation, and start a new deposit or withdrawal only after a known failure. Once an owner transaction is exposed for signing, refresh returns 409 with details.reason wallet_transaction_outcome_unknown, because SDP cannot invalidate bytes the owner holds. Timeout, blockhash expiry and missing RPC history never authorize a replacement. Replaying the original Idempotency-Key returns the original response without rebuilding; GET returns the current state. Requires earn.execute and fresh source admission.",
      cancel:
        "Cancels a preparation while canCancel is true, before any submission has been accepted. Otherwise it returns 409 CONFLICT: details.reason operation_already_submitted after an accepted submit, including while queued or waiting for a signature; wallet_transaction_outcome_unknown once an owner transaction is exposed for signing, because SDP cannot invalidate bytes the owner holds; operation_not_cancellable for any other state. It never cancels an onchain transaction, revokes a signature or cancels a submitted queued withdrawal, and closing your own wallet's signing prompt needs no API call. Success marks only an undispatched preparation cancelled. Requires earn.manage and current source authority.",
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
          committedServerErrors: "store",
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
                        actionId: "opa_example",
                        version: 1,
                        signedTransaction: "AQ==",
                      }
                    : action === "refresh"
                      ? { actionId: "opa_example", version: 1 }
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
