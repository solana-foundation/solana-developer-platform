import { SigningError } from "@sdp/custody/signing";
import { resolveRpcTarget } from "@sdp/rpc/relay";
import { confirmTransaction, createRpc, getRecentBlockhash } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { FeePaymentError } from "@/services/ports";
import { createOrgSigner } from "@/services/solana";
import { createAuthenticatedSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { AppContext } from "../context";
import { type SignerCheckResponse, signerCheckSchema } from "../schemas";

// biome-ignore lint/security/noSecrets: Solana Memo program id constant, not a secret.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const KORA_MEMO_ALLOWED_PROGRAM_HINT =
  "Add MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr to Kora validation.allowed_programs.";

function isKoraMemoProgramPolicyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("memo") &&
    (normalized.includes("allowed list") || normalized.includes("not in the allowed list"))
  );
}

export const signerCheck = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = signerCheckSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }
  const auth = getAuth(c);

  const resolvedWalletId = resolveApiKeySigningWalletId(auth, parsed.data.walletId, [
    "wallets:write",
  ]);
  if (resolvedWalletId === null) {
    throw badRequest(
      auth.authType === "api_key"
        ? "API key is not bound to a signing wallet"
        : "walletId is required for session or Clerk authentication"
    );
  }
  const memo = `SDP signer check ${crypto.randomUUID()}`;

  try {
    const feePayment = createAuthenticatedSponsorshipFeePayment(c);
    const [signer, feePayer, rpcTarget] = await Promise.all([
      createOrgSigner(c.env, auth.organizationId, auth.projectId, resolvedWalletId),
      feePayment.getFeePayer(),
      resolveRpcTarget({
        env: c.env,
        kv: c.var.kv,
        db: getDb(c.env),
        organizationId: auth.organizationId,
        authProjectId: auth.projectId,
        requestedProjectId: null,
      }),
    ]);

    const rpc = createRpc(c.env, {
      rpcUrl: rpcTarget.endpoint,
      headers: rpcTarget.headers,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");

    const memoInstruction = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER }],
      data: new TextEncoder().encode(memo),
    };

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (transaction) => setTransactionMessageFeePayer(feePayer, transaction),
      (transaction) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash, lastValidBlockHeight },
          transaction
        ),
      (transaction) => appendTransactionMessageInstructions([memoInstruction], transaction),
      (transaction) => addSignersToTransactionMessage([signer], transaction)
    );

    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const txEncoder = getTransactionEncoder();
    const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
    const signature = await feePayment.signAndSend(txBytes);

    const confirmation = await confirmTransaction(rpc, signature, {
      commitment: "confirmed",
    });

    if (confirmation.err) {
      throw new AppError("TRANSACTION_FAILED", "Memo signer check transaction failed on-chain");
    }

    const response: SignerCheckResponse = {
      walletId: resolvedWalletId,
      walletAddress: signer.address,
      feePayer,
      memo,
      signature,
      slot: Number(confirmation.slot),
      blockTime: new Date().toISOString(),
    };

    return success(c, response);
  } catch (error) {
    if (error instanceof FeePaymentError) {
      if (error.code === "RATE_LIMITED") {
        throw new AppError("RATE_LIMITED", `Kora rate limit exceeded: ${error.message}`);
      }

      if (isKoraMemoProgramPolicyError(error.message)) {
        throw new AppError(
          "BAD_REQUEST",
          `Kora rejected signer-check transaction: ${error.message}. ${KORA_MEMO_ALLOWED_PROGRAM_HINT}`
        );
      }

      throw new AppError(
        "SOLANA_RPC_ERROR",
        `Kora signer-check request failed: ${error.message}. Verify KORA_RPC_URL/KORA_API_KEY and Kora service health.`
      );
    }

    if (error instanceof SigningError) {
      throw badRequest(error.message);
    }

    if (error instanceof Error) {
      if (isKoraMemoProgramPolicyError(error.message)) {
        throw new AppError(
          "BAD_REQUEST",
          `Kora rejected signer-check transaction: ${error.message}. ${KORA_MEMO_ALLOWED_PROGRAM_HINT}`
        );
      }

      const message = error.message.toLowerCase();
      if (
        message.includes("kora") ||
        message.includes("fee payer") ||
        message.includes("sign and send") ||
        message.includes("internal error; reference")
      ) {
        throw new AppError(
          "SOLANA_RPC_ERROR",
          `Kora signer-check request failed: ${error.message}. Verify Kora availability and credentials.`
        );
      }
    }

    throw error;
  }
};
