import { address } from "@solana/kit";
import { SdpKaminoError } from "./errors";
import type { KaminoVaultAssetIdentity } from "./types";

type KaminoVaultMintState = {
  tokenMint?: unknown;
  sharesMint?: unknown;
};

/** Read and validate the asset mints from the live state used by the builder. */
export function vaultAssetIdentityFromState(state: unknown): KaminoVaultAssetIdentity {
  const mintState = state as KaminoVaultMintState | null;
  return {
    depositTokenMint: requiredMintAddress("tokenMint", mintState?.tokenMint),
    shareMint: requiredMintAddress("sharesMint", mintState?.sharesMint),
  };
}

function requiredMintAddress(field: string, value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  try {
    return address(raw);
  } catch (cause) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino vault state did not contain a valid ${field}`,
      { cause }
    );
  }
}
