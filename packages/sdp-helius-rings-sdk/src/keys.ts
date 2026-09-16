import type { LocalKeys, ZolanaClient } from "@heliuslabs/zolana/client";
import type { LocalShieldedKeys } from "@heliuslabs/zolana/transaction";
import type { ShieldedMaterial } from "./material.js";

/**
 * Turns {@link ShieldedMaterial} into the key interfaces Zolana asks for.
 *
 * Both forms copy the keys rather than borrow them, so each has its own
 * `destroy()` and must be scoped like the material it came from. The split is
 * the point: a read gets {@link readKeys}, which has no way to prove, so a sync
 * cannot spend even by mistake.
 */

/** Read and spend. `prove` completes the witness with the nullifier secret. */
export function spendKeys(material: ShieldedMaterial, client: ZolanaClient): LocalKeys {
  return material.spendKeys(client.proofService);
}

/** Read only: derivation and decryption, no proving. */
export function readKeys(material: ShieldedMaterial): LocalShieldedKeys {
  return material.readKeys();
}
