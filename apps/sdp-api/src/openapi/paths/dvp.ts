/**
 * DvP trade routes.
 *
 * Registered on the INTERNAL document only, deliberately. The routes are real
 * and mounted, but the whole family is behind `MARKETS_ENABLED` + `DVP_ENABLED`
 * and the swap program is deployed on devnet only (PRO-1798), so every
 * environment a customer can reach answers 403. Publishing them would document
 * an endpoint nobody can call. Promoting the family is one line in
 * `registerPublicPaths` plus a `"dvp"` slug in
 * `apps/sdp-docs/scripts/lib/public-openapi.mjs`, and it is a product-policy
 * decision rather than a code one.
 */

import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  createDvpTradeRequestSchema,
  dvpTradeIdParamSchema,
  errorResponseSchema,
  listDvpTradesQuerySchema,
  z,
} from "../schemas";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithIdempotencyHeaders,
} from "./helpers";
import { dvpCloseResponse, dvpTradeResponse, listDvpTradesResponse } from "./responses";

const DVP_TAG = "DvP";

const tradeIdPathParams = z.object({ tradeId: dvpTradeIdParamSchema });

export function registerDvpPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/dvp/trades",
    tags: [DVP_TAG],
    summary: "Create a DvP trade",
    operationId: "createDvpTrade",
    description:
      "Creates a delivery-versus-payment trade on chain and returns the escrow addresses to publish. Send an Idempotency-Key: a retry after an ambiguous broadcast returns the original trade, because without one the retry draws a fresh nonce and creates a SECOND trade at a different address while the first sits on chain with a published escrow nobody is watching. Only the SDP custody wallet signs: the counterparty signs nothing here and needs no integration, so a created trade is a proposal rather than an agreement. It is also permissionless on chain — anyone can create a trade naming anyone, and the economic terms are not part of the account address, so whoever funds a leg must verify the stored terms first. Returns 403 when DvP is not enabled for the environment.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeWithIdempotencyHeaders,
      body: { content: jsonContent(createDvpTradeRequestSchema) },
    },
    responses: {
      201: { description: "Trade created", content: jsonContent(dvpTradeResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/dvp/trades",
    tags: [DVP_TAG],
    summary: "List DvP trades",
    operationId: "listDvpTrades",
    description:
      "Lists DvP trades for the active project, newest first. A wallet-scoped API key sees only trades whose SDP leg is held by a wallet it is bound to.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listDvpTradesQuerySchema,
    },
    responses: {
      200: { description: "Trades", content: jsonContent(listDvpTradesResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/dvp/trades/{tradeId}",
    tags: [DVP_TAG],
    summary: "Get a DvP trade",
    operationId: "getDvpTrade",
    description:
      "Returns one DvP trade. A trade outside the API key's wallet scope answers 404 rather than 403, so nothing leaks about which trades exist.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: tradeIdPathParams,
    },
    responses: {
      200: { description: "Trade", content: jsonContent(dvpTradeResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  for (const action of ["settle", "cancel"] as const) {
    registry.registerPath({
      method: "post",
      path: `/v1/dvp/trades/{tradeId}/${action}`,
      tags: [DVP_TAG],
      summary: action === "settle" ? "Settle a DvP trade" : "Cancel a DvP trade",
      operationId: action === "settle" ? "settleDvpTrade" : "cancelDvpTrade",
      description:
        action === "settle"
          ? "Delivers each leg to the other party, refunds any surplus to its depositor, and closes the trade. Requires both legs funded. Only the project's settlement authority can do this, and the action is irreversible. Creates any token accounts settlement requires that do not yet exist — including the surplus-refund accounts, which the program demands even when there is no surplus, because anyone can send tokens to an escrow. Subject to wallet policy: a trade needing approval returns 202 with an approval request rather than settling."
          : "Refunds each leg to whoever deposited it and closes the trade. Unlike settlement this does not require the trade to be funded — unwinding a half-funded or abandoned trade is what it is for. Only the project's settlement authority can do this, and the action is irreversible. Subject to wallet policy: a cancel needing approval returns 202 rather than executing.",
      security: [{ apiKeyAuth: [] }],
      request: { headers: projectScopeHeaders, params: tradeIdPathParams },
      responses: {
        200: { description: "Trade closed", content: jsonContent(dvpCloseResponse) },
        202: {
          description: "Awaiting policy approval",
          content: jsonContent(errorResponseSchema),
        },
        ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
      },
    });
  }
}
