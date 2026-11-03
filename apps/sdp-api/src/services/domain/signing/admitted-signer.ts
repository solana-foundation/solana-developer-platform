import { SigningError } from "@sdp/custody/signing";
import type { CustodyProvider } from "@sdp/types/custody";
import type { MovementId } from "@sdp/types/movements";
import {
  assertIsTransactionSigner,
  isMessageModifyingSigner,
  isMessagePartialSigner,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { conflict, custodyPolicyRefused } from "@/lib/errors";
import { assertMovementAdmitted, type MoneyAdmissionDecision } from "@/lib/money-admission";
import { getLogger } from "@/runtime/logger";

/**
 * Rethrows a custody signing failure, as the API's `CUSTODY_POLICY_REFUSED` when the provider's
 * policy refused the signature and unchanged otherwise.
 *
 * @param error - What the custody signing call rejected with.
 * @param provider - The provider resolved for this custody wallet.
 * @returns Never; it always throws.
 */
function rethrowPolicyRefusal(error: unknown, provider: CustodyProvider): never {
  if (error instanceof SigningError && error.code === "POLICY_REFUSED") {
    throw custodyPolicyRefused(error, provider);
  }
  throw error;
}

/**
 * The BYOK credential a Connection signer was built from: the Connection, the
 * credential row it pointed at, and that credential's version and secret
 * version.
 */
export interface SignerCredentialBinding {
  connectionId: string;
  providerCredentialId: string;
  credentialVersion: number;
  secretVersionRef: string | null;
}

export interface AdmittedSignerContext {
  movement: MovementId;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  provider: CustodyProvider;
  /**
   * For a Connection (BYOK) wallet: the credential the signer was built from,
   * and a read of the Connection's current usable credential (null when it has
   * none). Managed and Config wallets omit it.
   */
  credential?: {
    bound: SignerCredentialBinding;
    readCurrent: () => Promise<SignerCredentialBinding | null>;
  };
}

function isSameCredential(
  bound: SignerCredentialBinding,
  current: SignerCredentialBinding | null
): boolean {
  return (
    current !== null &&
    current.connectionId === bound.connectionId &&
    current.providerCredentialId === bound.providerCredentialId &&
    current.credentialVersion === bound.credentialVersion &&
    current.secretVersionRef === bound.secretVersionRef
  );
}

/**
 * The custody signer for one movement (HOO-1955, HOO-2099). Each time it is
 * asked to sign it decides admission again, from live rows, and refuses what
 * is no longer admitted: a start the organization may no longer make, or any
 * movement, exits included, the ambient credential may no longer make with
 * this wallet (revoked, out of its wallet scope). An exit never depends on the
 * organization, so a suspended one can always unwind. A flow that holds a
 * signer across slow calls (Private Channels' gateway reads, retries)
 * therefore cannot sign after a suspension or revocation landed in between.
 *
 * Deciding at signing rather than at resolution also keeps work that only
 * confirms an earlier signature working: several flows resolve a signer before
 * they know whether they still need one. The wrapper offers exactly the
 * signing kinds the real signer does, so the kit guards classify it the same.
 * It is also where a custody provider's policy refusal becomes the API's 422
 * `CUSTODY_POLICY_REFUSED` (HOO-2333), once, for every flow that signs, with
 * the provider's `SigningError` as its cause.
 *
 * A Connection signer also holds the BYOK credential it was built from, and
 * each signature checks that the Connection still uses that exact credential.
 * A signer resolved before the tenant rotated or revoked it at SDP refuses to
 * sign rather than keep using the old secret, which SDP cannot invalidate at
 * the provider.
 */
export function admittedSigner(
  signer: TransactionSigner,
  decide: () => Promise<MoneyAdmissionDecision>,
  context: AdmittedSignerContext
): TransactionSigner {
  const rethrow = (error: unknown): never => rethrowPolicyRefusal(error, context.provider);
  const assertCredentialUnchanged = async () => {
    const credential = context.credential;
    if (!credential) return;
    if (isSameCredential(credential.bound, await credential.readCurrent())) return;
    getLogger().warn(
      {
        organizationId: context.organizationId,
        projectId: context.projectId,
        provider: context.provider,
        connectionId: credential.bound.connectionId,
        custodyWalletId: context.custodyWalletId,
        movement: context.movement,
      },
      "custody_signer_credential_changed"
    );
    throw conflict("Custody Connection credential changed after the signer was resolved", {
      reason: "runtime_execution_unavailable",
    });
  };
  const admit = async () => {
    // Both reads are by primary key and independent, so they run together.
    const [decision] = await Promise.all([decide(), assertCredentialUnchanged()]);
    assertMovementAdmitted(decision, {
      surface: "signer",
      movement: context.movement,
      organizationId: context.organizationId,
      projectId: context.projectId,
      subjectId: context.custodyWalletId,
    });
  };
  const admitted = {
    address: signer.address,
    ...(isTransactionPartialSigner(signer)
      ? {
          signTransactions: async (...args: Parameters<typeof signer.signTransactions>) => {
            await admit();
            return signer.signTransactions(...args).catch(rethrow);
          },
        }
      : {}),
    ...(isTransactionModifyingSigner(signer)
      ? {
          modifyAndSignTransactions: async (
            ...args: Parameters<typeof signer.modifyAndSignTransactions>
          ) => {
            await admit();
            return signer.modifyAndSignTransactions(...args).catch(rethrow);
          },
        }
      : {}),
    ...(isTransactionSendingSigner(signer)
      ? {
          signAndSendTransactions: async (
            ...args: Parameters<typeof signer.signAndSendTransactions>
          ) => {
            await admit();
            return signer.signAndSendTransactions(...args).catch(rethrow);
          },
        }
      : {}),
    ...(isMessagePartialSigner(signer)
      ? {
          signMessages: async (...args: Parameters<typeof signer.signMessages>) => {
            await admit();
            return signer.signMessages(...args).catch(rethrow);
          },
        }
      : {}),
    ...(isMessageModifyingSigner(signer)
      ? {
          modifyAndSignMessages: async (
            ...args: Parameters<typeof signer.modifyAndSignMessages>
          ) => {
            await admit();
            return signer.modifyAndSignMessages(...args).catch(rethrow);
          },
        }
      : {}),
  };
  assertIsTransactionSigner(admitted);
  return admitted;
}
