/**
 * Confidential-balance key derivation.
 *
 * Every confidential-transfer operation needs the token-account owner's ElGamal
 * keypair + AES key. They are never stored: they are re-derived per request from
 * a signature the owner's custody wallet produces, used, and freed.
 *
 * Derivation is wallet-only (`solana-conf-bal/v1`): one signature over a fixed
 * message yields both keys, with no owner, mint or token-account seed. A wallet
 * therefore has exactly one confidential key pair, shared across every mint and
 * every token account it holds — the same scheme token-2022 ships, so the keys
 * are byte-identical to any other client's.
 *
 * What used to be enforced by the seed is now enforced on-chain instead: the
 * mosaic builders compare the derived ElGamal pubkey against the one registered
 * on the account (`assertConfidentialKeysMatchAccount`) and refuse to build a
 * plan that could not verify. Accounts configured under the older owner+mint
 * scheme derive different keys and are caught there.
 */

import type { Address } from "@solana/kit";
import {
  type ConfidentialKeys,
  deriveConfidentialKeys,
  freeConfidentialKeys,
} from "@solana/mosaic-sdk/confidential";
import { isMessagePartialSigner } from "@solana/signers";
import { AppError } from "@/lib/errors";
import { createOrgSigner } from "@/services/solana";
import type { Env } from "@/types/env";

export type { ConfidentialKeys };

/**
 * Derive the confidential keys held by one custody wallet.
 *
 * The wallet must be able to sign arbitrary messages — the derivation signs a
 * canonical message. Not every custody provider supports that, so the capability
 * is checked before any work is done.
 *
 * `owner` does not seed the derivation any more, but the caller still passes the
 * address it expects and the check below still runs: deriving the wrong wallet's
 * keys no longer produces garbage, it produces another holder's perfectly valid
 * keys, and the mistake would only surface as a proof rejection deep inside
 * token-2022. Catching it here keeps it a 4xx with a legible message.
 */
export async function deriveConfidentialKeysForWallet(params: {
  env: Env;
  organizationId: string;
  projectId: string | null | undefined;
  walletId: string | null | undefined;
  owner: Address;
}): Promise<ConfidentialKeys> {
  const signer = await createOrgSigner(
    params.env,
    params.organizationId,
    params.projectId,
    params.walletId
  );

  if (!isMessagePartialSigner(signer)) {
    throw new AppError(
      "SIGNING_FAILED",
      "This wallet cannot sign the confidential-balance key derivation message."
    );
  }

  if (signer.address !== params.owner) {
    throw new AppError(
      "SIGNING_FAILED",
      "Confidential keys are derived from the holder's own wallet signature.",
      { hint: `Expected ${params.owner}, resolved ${signer.address}.` }
    );
  }

  try {
    return await deriveConfidentialKeys({ signer });
  } catch (error) {
    throw new AppError(
      "SIGNING_FAILED",
      "Failed to derive confidential balance keys for this wallet.",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Derive keys, run `use`, and always release them.
 *
 * `ConfidentialKeys` holds WASM-allocated memory that the garbage collector does
 * not reclaim, so the release is mandatory — in a long-lived API process a
 * missing `freeConfidentialKeys` is a leak on every request.
 */
export async function withConfidentialKeys<T>(
  params: Parameters<typeof deriveConfidentialKeysForWallet>[0],
  use: (keys: ConfidentialKeys) => Promise<T>
): Promise<T> {
  const keys = await deriveConfidentialKeysForWallet(params);
  try {
    return await use(keys);
  } finally {
    freeConfidentialKeys(keys);
  }
}
