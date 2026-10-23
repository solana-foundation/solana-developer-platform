import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  quoteTokenAmountRequestSchema,
  tokenAmountQuoteSchema,
  tokenMintParamsSchema,
  tokenTermsSchema,
} from "@/openapi/schemas/tokens";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

const METERED =
  "The endpoint reads the chain once and is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.";

export function registerTokenPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/tokens/{mint}/terms",
    tags: ["Payments"],
    summary: "Get token terms",
    operationId: "getTokenTerms",
    description: `Reads a mint's Token Terms live: decimals, token program, the transfer-fee schedule (the entry in force this epoch and next epoch), the display rule (plain, scaled UI amount or interest-bearing), the hook program, paused, non-transferable and default-frozen state, and whether each movement path this deployment runs can move the token now, with every reason it cannot. Nothing is cached: every field can change on chain. Requires \`transfers.read\`. ${METERED}`,
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: tokenMintParamsSchema },
    responses: {
      200: {
        description: "Token terms",
        content: jsonContent(successResponseSchema(z.object({ terms: tokenTermsSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/tokens/{mint}/quote",
    tags: ["Payments"],
    summary: "Quote a token amount",
    operationId: "quoteTokenAmount",
    description: `Prices an amount under the mint's live terms: what leaves the sender (\`debit\`), the transfer fee withheld in the destination (\`fee\`) and what the recipient receives (\`credit\`), in token units, with the display values of a scaled or interest-bearing mint. Send \`amount\` in token units, or \`displayAmount\` as wallets show it to get the token amount to send. It moves and stores nothing, takes no Idempotency-Key, and the movement is priced again when it is built. Requires \`transfers.read\`. ${METERED}`,
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: tokenMintParamsSchema,
      body: {
        required: true,
        content: jsonContent(quoteTokenAmountRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Token amount quote",
        content: jsonContent(successResponseSchema(z.object({ quote: tokenAmountQuoteSchema }))),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
}
