import { z } from "zod";

const tokenAmount = z.object({ mint: z.string(), value: z.string() });
const source = z.union([
  z.object({ walletId: z.string() }),
  z.object({ ownerAddress: z.string() }),
]);

/** Public operation observations, never inferred balances or settled proceeds. */
export const coreOperationSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(["earn.deposit", "earn.withdraw"]),
  status: z.enum([
    "prepared",
    "queued",
    "awaiting_signature",
    "submitted",
    "settling",
    "completed",
    "failed",
    "cancelled",
  ]),
  intent: z.discriminatedUnion("kind", [
    z.looseObject({
      kind: z.literal("earn.deposit"),
      strategyId: z.string(),
      source,
      amount: tokenAmount,
      feePayer: z.string().optional(),
    }),
    z.looseObject({
      kind: z.literal("earn.withdraw"),
      positionId: z.string(),
      amount: z.object({
        kind: z.string(),
        value: z.string().optional(),
        mint: z.string().optional(),
      }),
      feePayer: z.string().optional(),
    }),
  ]),
  actionId: z.string(),
  version: z.number().int().positive(),
  nextAction: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("sign_transaction"),
        transaction: z.string(),
        lastValidBlockHeight: z.string(),
        expiresAt: z.string().nullable(),
      }),
      z.object({ type: z.literal("submit") }),
      z.object({ type: z.literal("select_option") }),
      z.object({ type: z.literal("refresh") }),
      z.object({
        type: z.literal("sign_in_provider"),
        provider: z.string(),
        providerTransactionId: z.string(),
        instructions: z.string(),
        handoffUrl: z.string().nullable(),
      }),
      z.object({ type: z.literal("wait"), reason: z.string() }),
    ])
    .nullable(),
  terms: z.object({
    inputAmount: tokenAmount.nullable().optional(),
    description: z.string().optional(),
    expiresAt: z.string().nullable(),
    estimate: tokenAmount.nullable(),
    minimum: tokenAmount.nullable(),
    fees: z.array(z.looseObject(tokenAmount.shape)).nullable(),
    options: z.array(
      z.looseObject({
        id: z.string(),
        label: z.string(),
        settlement: z.enum(["instant", "delayed"]),
      })
    ),
  }),
  resourceRef: z.object({ kind: z.string(), id: z.string() }).nullable(),
  result: z
    .looseObject({
      positionId: z.string(),
      signature: z.string().nullable(),
      strategyId: z.string().optional(),
      source: source.optional(),
      settledAmount: tokenAmount.nullable().optional(),
      settlementOutcome: z
        .enum(["delivered", "cancelled"])
        .nullable()
        .optional(),
    })
    .nullable(),
  canCancel: z.boolean(),
  cancelRequestedAt: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EarnOperation = z.infer<typeof coreOperationSchema>;

/** A queue request or chain submission remains active until verified settlement. */
export function isOperationActive(operation: EarnOperation): boolean {
  return !["completed", "failed", "cancelled"].includes(operation.status);
}
