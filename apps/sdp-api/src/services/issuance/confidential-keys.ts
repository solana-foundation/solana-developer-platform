/**
 * Confidential-balance key derivation.
 *
 * Every confidential-transfer operation needs the token-account owner's ElGamal
 * keypair + AES key. They are never stored: they are re-derived per request from
 * a signature the owner's custody wallet produces, used, and freed.
 *
 * HOO-1507 gate: mosaic-sdk 0.2.0 ships the legacy owner+mint scheme
 * (`deriveConfidentialKeysForOwnerMint`). Upstream has since agreed on a
 * sign-once/HKDF scheme (token-2022#1432) that 0.2.0 does not ship yet, and
 * changing the seed changes the keys of every already-configured account. Every
 * caller goes through `deriveConfidentialKeysForWallet` so that migration is a
 * one-function change.
 */

import type { Address } from "@solana/kit";
import {
  type ConfidentialKeys,
  deriveConfidentialKeysForOwnerMint,
  freeConfidentialKeys,
} from "@solana/mosaic-sdk/confidential";
import { isMessagePartialSigner } from "@solana/signers";
import { AppError } from "@/lib/errors";
import { createOrgSigner } from "@/services/solana";
import type { Env } from "@/types/env";

export type { ConfidentialKeys };

/**
 * Derive the confidential keys for one custody wallet's token account.
 *
 * The wallet must be able to sign arbitrary messages — the derivation signs a
 * canonical message bound to `(owner, mint)`. Not every custody provider
 * supports that, so the capability is checked before any work is done.
 */
export async function deriveConfidentialKeysForWallet(params: {
  env: Env;
  organizationId: string;
  projectId: string | null | undefined;
  walletId: string | null | undefined;
  owner: Address;
  mint: Address;
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
      "Confidential balances can only be derived by the account owner's own wallet.",
      { hint: `Expected ${params.owner}, resolved ${signer.address}.` }
    );
  }

  try {
    return await deriveConfidentialKeysForOwnerMint({
      signer,
      owner: params.owner,
      mint: params.mint,
    });
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
