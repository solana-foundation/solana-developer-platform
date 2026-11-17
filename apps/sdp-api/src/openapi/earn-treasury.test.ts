import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as requests from "@/routes/earn/schemas";
import { earnExternalWalletWithdrawalPreviewRequest } from "./schemas/earn";
import {
  EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_VAULT_DEPOSIT_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
} from "./schemas/earn-examples";
import {
  earnMovementsQuery,
  earnVaultDepositParams,
  earnVaultDepositRequest,
  earnVaultDepositsQuery,
  earnVaultPositionsQuery,
  earnVaultQueuedWithdrawalPreviewRequest,
  earnVaultWithdrawalOptionsRequest,
  earnVaultWithdrawalParams,
  earnVaultWithdrawalRequest,
  earnVaultWithdrawalRequestCreateRequest,
  earnVaultWithdrawalRequestParams,
  earnVaultWithdrawalRequestsQuery,
  earnVaultWithdrawalsQuery,
} from "./schemas/earn-treasury";

interface Fields {
  properties: string[];
  required: string[];
  /** Whether the body refuses a field it does not name. */
  strict: boolean;
}

/** A schema's field names, required set and strictness, one entry per union variant, in a stable order. */
function fieldsOf(schema: z.ZodType): Fields[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
    anyOf?: {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    }[];
  };
  return (json.anyOf ?? [json])
    .map((variant) => ({
      // A runtime body declares `requestId` as `never`, only to refuse it; no document shows it.
      properties: Object.entries(variant.properties ?? {})
        .filter(([, field]) => JSON.stringify(field) !== JSON.stringify({ not: {} }))
        .map(([name]) => name)
        .sort(),
      required: [...(variant.required ?? [])].sort(),
      strict: variant.additionalProperties === false,
    }))
    .sort((a, b) => a.properties.join().localeCompare(b.properties.join()));
}

describe("documented Treasury requests", () => {
  it.each([
    ["deposit", earnVaultDepositRequest, requests.earnVaultDepositSchema],
    ["withdrawal", earnVaultWithdrawalRequest, requests.earnVaultWithdrawalSchema],
    [
      "withdrawal preview",
      earnExternalWalletWithdrawalPreviewRequest,
      requests.earnVaultWithdrawalPreviewSchema,
    ],
    [
      "withdrawal options",
      earnVaultWithdrawalOptionsRequest,
      requests.earnVaultWithdrawalOptionsSchema,
    ],
    [
      "queued withdrawal preview",
      earnVaultQueuedWithdrawalPreviewRequest,
      requests.earnVaultQueuedWithdrawalPreviewSchema,
    ],
    [
      "withdrawal request",
      earnVaultWithdrawalRequestCreateRequest,
      requests.earnVaultWithdrawalRequestSchema,
    ],
    ["deposits query", earnVaultDepositsQuery, requests.earnVaultDepositsQuerySchema],
    ["withdrawals query", earnVaultWithdrawalsQuery, requests.earnVaultWithdrawalsQuerySchema],
    ["positions query", earnVaultPositionsQuery, requests.earnVaultPositionsQuerySchema],
    [
      "withdrawal requests query",
      earnVaultWithdrawalRequestsQuery,
      requests.earnVaultWithdrawalRequestsQuerySchema,
    ],
    ["movements query", earnMovementsQuery, requests.earnMovementsQuerySchema],
    ["deposit params", earnVaultDepositParams, requests.earnVaultDepositParamsSchema],
    ["withdrawal params", earnVaultWithdrawalParams, requests.earnVaultWithdrawalParamsSchema],
    [
      "withdrawal request params",
      earnVaultWithdrawalRequestParams,
      requests.earnVaultWithdrawalRequestParamsSchema,
    ],
  ] as const)(
    "%s names the fields the route validates, as strictly",
    (_name, documented, runtime) => {
      expect(fieldsOf(documented)).toEqual(fieldsOf(runtime));
    }
  );

  it.each([
    ["deposit", requests.earnVaultDepositSchema, EARN_VAULT_DEPOSIT_REQUEST_EXAMPLE],
    ["withdrawal", requests.earnVaultWithdrawalSchema, EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE],
    [
      "withdrawal preview",
      requests.earnVaultWithdrawalPreviewSchema,
      EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
    ],
    [
      "withdrawal options",
      requests.earnVaultWithdrawalOptionsSchema,
      EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
    ],
    [
      "queued withdrawal preview",
      requests.earnVaultQueuedWithdrawalPreviewSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
    [
      "withdrawal request",
      requests.earnVaultWithdrawalRequestSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
  ] as const)("the %s example is a body the route accepts", (_name, runtime, example) => {
    expect(runtime.safeParse(example).success).toBe(true);
  });

  it("refuses a body requestId on every route that signs, as the documents say", () => {
    for (const [runtime, example] of [
      [requests.earnVaultDepositSchema, EARN_VAULT_DEPOSIT_REQUEST_EXAMPLE],
      [requests.earnVaultWithdrawalSchema, EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE],
      [requests.earnVaultWithdrawalRequestSchema, EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE],
    ] as const) {
      expect(runtime.safeParse({ ...example, requestId: crypto.randomUUID() }).success).toBe(false);
    }
  });
});
