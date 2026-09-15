import { SigningError } from "@sdp/custody/signing";
import { resolveRpcTarget } from "@sdp/rpc/relay";
import { createRpcFromTransport, getRecentBlockhash, simulateTransaction } from "@sdp/rpc/solana";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types";
import type { Address, SignatureBytes } from "@solana/kit";
import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, conflict } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertFreshApiKeyCustodyWalletAccess,
  resolveApiKeySigningWalletId,
} from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { FeePaymentError } from "@/services/ports";
import { createRpcTransportForTarget } from "@/services/rpc-egress";
import { createOrgSignerForCustodyWallet } from "@/services/solana";
import { createAuthenticatedSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { SignerCheckResponse, signerCheckSchema } from "../schemas";
import { findAuthorizedOperationalWallet } from "./wallets";

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

  const resolvedWalletId = resolveApiKeySigningWalletId(auth, body.walletId, ["wallets:write"]);
  if (resolvedWalletId === null) {
    throw badRequest(
      auth.authType === "api_key"
        ? "API key is not bound to a signing wallet"
        : "walletId is required for session or Clerk authentication"
    );
  }
  const memo = `SDP signer check ${crypto.randomUUID()}`;

  try {
    const wallet = await findAuthorizedOperationalWallet(c, resolvedWalletId, ["wallets:write"]);
    if (!wallet) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, wallet.id, ["wallets:write"]);
    // Keep the legacy selector's retained-Connection checks; inventory hides inactive rows.
    const target = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).resolve({
      kind: "wallet",
      organizationId: auth.organizationId,
      projectId: auth.projectId ?? undefined,
      walletId: resolvedWalletId,
    });
    // A retained project Connection must not disappear into the org-Config inventory fallback.
    if (target?.kind === "connection" && target.connectionId !== wallet.custodyConnectionId) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    // Resolve once to an exact row, then admit before any signer, Kora, or RPC work.
    // The exact signer repeats its runtime guard; a default change cannot select another wallet.
    await createSigningService(c.env, getRequestTenantScope(c)).admitRuntimeExecution(
      auth.organizationId,
      auth.projectId ?? undefined,
      wallet.id
    );

    // The sponsorship port supplies only the fee payer ADDRESS, so the
    // simulated message has a funded payer. The check never calls signAndSend:
    // a signer check is diagnostics, and diagnostics must not be able to spend
    // sponsorship — the transaction below is verified locally and in RPC
    // simulation, and is never broadcast.
    const feePayment = createAuthenticatedSponsorshipFeePayment(c);
    const [signer, feePayer, rpcTarget] = await Promise.all([
      createOrgSignerForCustodyWallet(c.env, auth.organizationId, auth.projectId, wallet.id),
      feePayment.getFeePayer(),
      resolveRpcTarget({
        env: c.env,
        kv: c.var.kv,
        db: getDb(c.env),
        organizationId: auth.organizationId,
        authProjectId: auth.projectId,
        requestedProjectId: null,
        // Deliberately no tenant connection lookup: signer check stays on the
        // platform rail. It is API-key reachable and organization-wide, so
        // routing it through the fail-closed resolver would let one mistyped
        // key on an unrelated surface take this endpoint down for every
        // caller. The blast radius of a bad tenant credential belongs to the
        // RPC relay.
      }),
    ]);

    // The `custom` provider endpoint is project-supplied and only URL-checked
    // on write, so it goes through the guarded transport like the relay's
    // (HOO-1560). Platform targets keep the ordinary fetch.
    const rpc = createRpcFromTransport(createRpcTransportForTarget(rpcTarget));

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
        `Kora signer-check request failed: ${error.message}. Verify KORA_RPC_URL/KORA_API_KEY and Kora service health.`
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
