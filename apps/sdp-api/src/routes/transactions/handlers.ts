import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { accepted, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { CustodyService } from "@/services/custody";
import { createRpc, sendAndConfirmTransaction } from "@/services/solana";
import type { Env } from "@/types/env";
import type {
  CustodySignAsyncResponse,
  CustodySignSyncResponse,
  GetSigningStatusResponse,
  SubmitTransactionResponse,
} from "@sdp/types";
import type { Context } from "hono";
import { signTransactionSchema, submitTransactionSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

const validOperationTypes = ["deploy", "mint", "burn", "freeze", "unfreeze", "transfer"] as const;

type OperationType = (typeof validOperationTypes)[number];

const isValidOperationType = (value: unknown): value is OperationType =>
  typeof value === "string" && validOperationTypes.includes(value as OperationType);

export const submitTransaction = async (c: AppContext) => {
  // Auth context available for future authorization checks
  getAuth(c);

  const body = await c.req.json();
  const parsed = submitTransactionSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Validate base64 transaction
  let txBytes: Uint8Array;
  try {
    txBytes = new Uint8Array(Buffer.from(parsed.data.transaction, "base64"));
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid transaction encoding. Expected base64.");
  }

  // Submit to Solana
  const rpc = createRpc(c.env);
  const commitment = parsed.data.options?.commitment ?? "confirmed";

  try {
    const result = await sendAndConfirmTransaction(rpc, txBytes, {
      skipPreflight: parsed.data.options?.skipPreflight ?? false,
      commitment,
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "submit",
      resourceType: "transaction",
      resourceId: result.signature,
      metadata: {
        commitment,
        slot: result.slot?.toString(),
        linkedTransactionId: parsed.data.transactionId,
      },
    });

    const response: SubmitTransactionResponse = {
      signature: result.signature,
      status: result.confirmationStatus ?? commitment,
      slot: result.slot ? Number(result.slot) : undefined,
    };

    return success(c, { data: response });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Audit the failure
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "submit_failed",
      resourceType: "transaction",
      resourceId: parsed.data.transactionId ?? "unknown",
      metadata: { error: errorMessage },
    });

    throw new AppError("TRANSACTION_FAILED", `Transaction submission failed: ${errorMessage}`);
  }
};

export const signTransaction = async (c: AppContext) => {
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = signTransactionSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Validate base64 transaction
  try {
    Buffer.from(parsed.data.transaction, "base64");
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid transaction encoding. Expected base64.");
  }

  const custodyService = new CustodyService(c.env.DB, c.env);

  // Get the provider's public key
  const publicKey = await custodyService.getPublicKey(
    auth.organizationId,
    auth.projectId ?? undefined,
    parsed.data.walletId
  );

  const metadata =
    parsed.data.metadata?.operationType && isValidOperationType(parsed.data.metadata.operationType)
      ? {
          operationType: parsed.data.metadata.operationType,
          tokenId: parsed.data.metadata.tokenId,
          amount: parsed.data.metadata.amount,
          destination: parsed.data.metadata.destination,
        }
      : undefined;

  // Sign the transaction
  const result = await custodyService.signTransaction(
    auth.organizationId,
    auth.projectId ?? undefined,
    {
      transactionMessage: parsed.data.transaction,
      signers: [{ publicKey, walletId: parsed.data.walletId }],
      metadata,
    }
  );

  // Audit log
  const auditService = new AuditService(c.env.DB);

  if (result.completed && result.signedTransaction) {
    await auditService.log(c, {
      action: "sign",
      resourceType: "transaction",
      resourceId: "signed",
      metadata: {
        status: "completed",
        walletId: parsed.data.walletId,
      },
    });

    const response: CustodySignSyncResponse = {
      signedTransaction: result.signedTransaction,
      status: "completed",
    };

    return success(c, { data: response });
  }

  if (result.status === "pending_approval" && result.signingRequestId) {
    await auditService.log(c, {
      action: "sign_requested",
      resourceType: "signing_request",
      resourceId: result.signingRequestId,
      metadata: {
        status: "pending_approval",
        walletId: parsed.data.walletId,
      },
    });

    const response: CustodySignAsyncResponse = {
      signingRequestId: result.signingRequestId,
      status: "pending_approval",
    };

    // Return 202 Accepted for async operations
    return accepted(c, { data: response });
  }

  // Handle errors
  throw new AppError("SIGNING_FAILED", result.error ?? "Transaction signing failed");
};

export const getSigningStatus = async (c: AppContext) => {
  const { requestId } = c.req.param();
  // Auth context available for future authorization checks
  getAuth(c);

  const custodyService = new CustodyService(c.env.DB, c.env);
  const status = await custodyService.getSigningStatus(requestId);

  // Map to API response format
  const response: GetSigningStatusResponse = {
    status: status.status,
  };

  if (status.status === "pending" && "approvals" in status) {
    response.approvals = status.approvals;
    response.required = status.required;
  }

  if (status.status === "completed" && "signatures" in status) {
    response.signatures = status.signatures;
  }

  if (status.status === "rejected" && "reason" in status) {
    response.reason = status.reason;
  }

  if (status.status === "failed" && "error" in status) {
    response.error = status.error;
  }

  return success(c, { data: response });
};
