import {
  signTransactionSchema as signTransactionSchemaBase,
  submitTransactionSchema as submitTransactionSchemaBase,
} from "../../routes/transactions/schemas";
import { z } from "./base";
import { base64Schema, signingRequestIdParamSchema, solanaAddressSchema } from "./base";

export const submitTransactionResponseSchema = z
  .object({
    signature: z
      .string()
      .openapi({ description: "Solana transaction signature.", example: "sig_example" }),
    status: z
      .enum(["processed", "confirmed", "finalized", "failed"])
      .openapi({ description: "Submission status.", example: "confirmed" }),
    slot: z.number().int().optional().openapi({
      description: "Slot number when the transaction was processed.",
      example: 123456,
    }),
    error: z.string().optional().openapi({
      description: "Error message if submission failed.",
      example: "Blockhash not found",
    }),
  })
  .openapi({ description: "Transaction submission response payload." });

export const custodySignSyncResponseSchema = z
  .object({
    signedTransaction: base64Schema.openapi({
      description: "Base64-encoded signed transaction.",
      example: "AQID",
    }),
    status: z.literal("completed").openapi({ description: "Signing status." }),
  })
  .openapi({ description: "Custody signing completed response." });

export const custodySignAsyncResponseSchema = z
  .object({
    signingRequestId: signingRequestIdParamSchema,
    status: z.literal("pending_approval").openapi({ description: "Signing status." }),
  })
  .openapi({ description: "Custody signing pending response." });

export const getSigningStatusResponseSchema = z
  .object({
    status: z
      .enum(["pending", "completed", "rejected", "failed"])
      .openapi({ description: "Signing request status.", example: "pending" }),
    approvals: z
      .number()
      .int()
      .optional()
      .openapi({ description: "Number of approvals collected.", example: 1 }),
    required: z
      .number()
      .int()
      .optional()
      .openapi({ description: "Number of required approvals.", example: 2 }),
    signatures: z
      .array(
        z.object({
          publicKey: solanaAddressSchema.openapi({
            description: "Signer public key.",
            example: "So11111111111111111111111111111111111111112",
          }),
          signature: z
            .string()
            .openapi({ description: "Signature string.", example: "sig_example" }),
        })
      )
      .optional()
      .openapi({ description: "Collected signatures." }),
    reason: z
      .string()
      .optional()
      .openapi({ description: "Reason for rejection, if applicable.", example: "Policy denied" }),
    error: z
      .string()
      .optional()
      .openapi({ description: "Error message if signing failed.", example: "Custody unavailable" }),
  })
  .openapi({ description: "Signing status response payload." });

export const submitTransactionRequestSchema = submitTransactionSchemaBase
  .extend({
    transaction: submitTransactionSchemaBase.shape.transaction.openapi({
      description: "Base64-encoded signed transaction.",
      example: "AQID",
    }),
    transactionId: submitTransactionSchemaBase.shape.transactionId.openapi({
      description: "Optional internal transaction identifier.",
      example: "tx_example",
    }),
    options: submitTransactionSchemaBase.shape.options.openapi({
      description: "Submission options.",
      example: { skipPreflight: false, commitment: "confirmed" },
    }),
  })
  .openapi({ description: "Submit transaction request body." });

export const signTransactionRequestSchema = signTransactionSchemaBase
  .extend({
    transaction: signTransactionSchemaBase.shape.transaction.openapi({
      description: "Base64-encoded unsigned transaction.",
      example: "AQID",
    }),
    walletId: signTransactionSchemaBase.shape.walletId.openapi({
      description: "Optional custody wallet identifier.",
      example: "wal_example",
    }),
    metadata: signTransactionSchemaBase.shape.metadata.openapi({
      description: "Optional signing metadata for audit and routing.",
      example: {
        operationType: "mint",
        tokenId: "tok_example",
        amount: "1000",
        destination: "So11111111111111111111111111111111111111112",
      },
    }),
  })
  .openapi({ description: "Sign transaction request body." });
