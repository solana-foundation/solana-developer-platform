/**
 * The supply-authority wallet behind a `ConfidentialMintBurn` mint.
 *
 * The mint's encrypted supply is protected by one wallet's own confidential
 * keys. Key derivation is wallet-only and carries no mint or role seed, so those
 * keys are *also* that wallet's account keys for every mint it holds — which is
 * why the supply authority must be a dedicated wallet that holds no confidential
 * balances of its own.
 *
 * It follows that nothing on-chain can identify it: the mint stores a supply
 * ElGamal public key, not a Solana address, and no amount of mint state lets you
 * work back to the wallet. So SDP records the address at creation and resolves
 * the wallet from its own row — then checks the derived key against the mint,
 * which is what proves the record still describes reality.
 */

import type { Address } from "@sdp/solana/address";
import { assertValidAddress } from "@sdp/solana/address";
import { getConfidentialMintBurnInit } from "@solana/mosaic-sdk/confidential";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { type ConfidentialKeys, withConfidentialKeys } from "@/services/issuance/confidential-keys";
import type { Env } from "@/types/env";
import { resolveAuthorityWallet } from "./authority-resolution";

/** The two values `ConfidentialMintBurn` is initialized with at mint creation. */
export interface ConfidentialMintBurnInit {
  supplyElgamalPubkey: Address;
  /** 36-byte AES ciphertext of a zero supply. */
  decryptableSupply: Uint8Array;
}

interface SupplyWalletParams {
  env: Env;
  auth: ApiKeyContext;
  /** The recorded supply-authority address. */
  supplyAuthority: string;
  requestedCustodyWalletId?: string | null;
}

/**
 * Resolve the custody wallet that holds the supply keys, checking the caller may
 * use it. `tokens:admin` rather than `tokens:write`: these keys can decrypt the
 * mint's whole supply history, and handing them out is not an ordinary write.
 */
async function resolveSupplyWallet(params: SupplyWalletParams) {
  return resolveAuthorityWallet({
    env: params.env,
    auth: params.auth,
    requestedCustodyWalletId: params.requestedCustodyWalletId,
    currentAuthority: params.supplyAuthority,
    requiredWalletPermissions: ["tokens:admin"],
  });
}

/**
 * Run `use` with the mint's supply keys, always releasing them afterwards.
 *
 * The keys are proof material, not a signer — the mint authority is what signs a
 * confidential mint or burn — so this resolves a different wallet from the one
 * running the operation.
 */
export async function withSupplyKeys<T>(
  params: SupplyWalletParams,
  use: (keys: ConfidentialKeys) => Promise<T>
): Promise<T> {
  const owner = assertValidAddress(params.supplyAuthority, "supplyAuthority");
  const { providerWalletId } = await resolveSupplyWallet(params);

  return withConfidentialKeys(
    {
      env: params.env,
      organizationId: params.auth.organizationId,
      projectId: params.auth.projectId ?? null,
      walletId: providerWalletId,
      owner,
    },
    use
  );
}

/**
 * Derive the `ConfidentialMintBurn` init values for a mint about to be created.
 *
 * Both are copied out of WASM by `getConfidentialMintBurnInit`, so they outlive
 * the keys this frees on the way out.
 */
export async function resolveConfidentialMintBurnInit(
  params: SupplyWalletParams
): Promise<ConfidentialMintBurnInit> {
  return withSupplyKeys(params, async (keys) => {
    const init = getConfidentialMintBurnInit(keys);
    return {
      supplyElgamalPubkey: assertValidAddress(init.supplyElgamalPubkey, "supplyElgamalPubkey"),
      decryptableSupply: new Uint8Array(init.decryptableSupply),
    };
  });
}

/**
 * The supply authority recorded for a token, or a 400 naming what is missing.
 *
 * A token that carries the extension without the record cannot be operated at
 * all — nothing else can name the wallet — so this is worth failing loudly
 * rather than falling back to the mint authority, whose keys would decrypt a
 * different supply and produce an opaque proof rejection on-chain.
 */
export function requireSupplyAuthority(token: {
  extensions?: { confidentialMintBurn?: { supplyAuthority?: string } | null } | null;
}): string {
  const supplyAuthority = token.extensions?.confidentialMintBurn?.supplyAuthority;
  if (!supplyAuthority) {
    throw new AppError(
      "CONFIDENTIAL_NOT_ENABLED",
      "This token has no supply-authority wallet recorded for its encrypted supply.",
      {
        hint:
          "Confidential mint and burn need the wallet the mint was created with; it cannot be " +
          "recovered from the mint, which stores only the supply public key.",
      }
    );
  }
  return supplyAuthority;
}
