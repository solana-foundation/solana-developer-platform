import { SigningError } from "@sdp/custody/signing";
import { FeePaymentError } from "@sdp/fee-payment/port";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash, simulateTransaction } from "@sdp/rpc/solana";
import type { SignerCheckResponse } from "@sdp/types/custody";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import {
  AccountRole,
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getDb } from "@/db/client";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, conflict } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import type { signerCheckSchema } from "@/routes/custody/schemas";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  resolveRequestSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import { findProjectOperationalWallet } from "./wallets";

/**
 * Whether `signature` is the custody wallet's own valid Ed25519 signature over
 * the compiled check message. The custody adapter returning bytes is not the
 * same as the custody adapter returning a WORKING signature, and this check
 * exists to answer the second question.
 */
async function isValidWalletSignature(
  walletAddress: Address,
  signature: SignatureBytes,
  messageBytes: Uint8Array
): Promise<boolean> {
  const publicKeyBytes = getAddressEncoder().encode(walletAddress);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(publicKeyBytes),
    "Ed25519",
    true,
    ["verify"]
  );
  return verifySignature(publicKey, signature, messageBytes);
}

export const signerCheck = async (c: ValidatedBodyContext<typeof signerCheckSchema>) => {
  const body = c.req.valid("json");
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const resolvedWalletId = body.walletId;
  const memo = `SDP signer check ${crypto.randomUUID()}`;

  try {
    const wallet = await findProjectOperationalWallet(c, resolvedWalletId);
    if (!wallet) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    // Keep the legacy selector's retained-Connection checks; inventory hides inactive rows.
    const target = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).resolve({
      kind: "wallet",
      organizationId: auth.organizationId,
      projectId,
      walletId: resolvedWalletId,
    });
    // The legacy selector and the inventory must agree on the Connection; a mismatch is ambiguous ownership.
    if (target?.kind === "connection" && target.connectionId !== wallet.custodyConnectionId) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    // Resolve once to an exact row, then admit before any signer, Kora, or RPC work.
    // The exact signer repeats its runtime guard against the same wallet row.
    await createSigningService(c.env, getRequestTenantScope(c)).admitRuntimeExecution(
      auth.organizationId,
      projectId,
      wallet.id
    );

    // The sponsorship port supplies only the fee payer ADDRESS, so the
    // simulated message has a funded payer. The check never calls signAndSend:
    // a signer check is diagnostics, and diagnostics must not be able to spend
    // sponsorship — the transaction below is verified locally and in RPC
    // simulation, and is never broadcast.
    const [signer, feePayer] = await Promise.all([
      createOrgSignerForCustodyWallet(
        c.env,
        auth.organizationId,
        projectId,
        wallet.id,
        "custody.signer_check"
      ),
      resolveSponsoredFeePayer(c.env, resolveRequestSponsorshipScope(c)),
    ]);

    const rpc = createClusterRpc();

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
    const walletSignature = partiallySigned.signatures[signer.address];
    if (!walletSignature) {
      throw new AppError(
        "TRANSACTION_FAILED",
        "Custody signer did not produce a signature for the check message"
      );
    }
    const signatureValid = await isValidWalletSignature(
      signer.address,
      walletSignature,
      new Uint8Array(partiallySigned.messageBytes)
    );
    if (!signatureValid) {
      throw new AppError(
        "TRANSACTION_FAILED",
        "Custody signer produced an invalid signature for the check message"
      );
    }

    const txEncoder = getTransactionEncoder();
    const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
    const simulation = await simulateTransaction(rpc, txBytes);
    if (!simulation.success) {
      throw new AppError(
        "TRANSACTION_FAILED",
        `Memo signer check simulation failed: ${simulation.error ?? "unknown error"}`
      );
    }

    const response: SignerCheckResponse = {
      walletId: resolvedWalletId,
      walletAddress: signer.address,
      feePayer,
      memo,
      signature: getBase58Decoder().decode(walletSignature),
      simulated: true,
      checkedAt: new Date().toISOString(),
    };

    return success(c, response);
  } catch (error) {
    if (error instanceof FeePaymentError) {
      if (error.code === "RATE_LIMITED") {
        throw new AppError("RATE_LIMITED", `Kora rate limit exceeded: ${error.message}`);
      }

      throw new AppError(
        "SOLANA_RPC_ERROR",
        `Kora signer-check request failed: ${error.message}. Verify KORA_<CLUSTER>_URL/KORA_<CLUSTER>_API_KEY and Kora service health.`
      );
    }

    if (error instanceof SigningError) {
      throw badRequest(error.message);
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes("kora") ||
        message.includes("fee payer") ||
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
