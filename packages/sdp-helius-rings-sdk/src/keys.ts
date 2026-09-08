import { LocalKeys, type ZolanaClient } from "@heliuslabs/zolana/client";
import { LocalShieldedKeys } from "@heliuslabs/zolana/transaction";
import type { ShieldedMaterial } from "./material.js";

/**
 * Turns {@link ShieldedMaterial} into the key interfaces Zolana asks for.
 *
 * Both forms copy the keys rather than borrow them, so each has its own
 * `destroy()` and must be scoped like the material it came from. The split is
 * the point: a read gets {@link readKeys}, which has no way to prove, so a sync
 * cannot spend even by mistake.
 */

/** One source for the trio, so a fourth key cannot reach only one of the two. */
function keyTrio(material: ShieldedMaterial) {
  return {
    address: material.shieldedAddress,
    viewingKeys: [material.viewingKey],
    nullifierKey: material.nullifierKey,
  };
}

/** Read and spend. `prove` completes the witness with the nullifier secret. */
export function spendKeys(material: ShieldedMaterial, client: ZolanaClient): LocalKeys {
  return LocalKeys.fromKeys(keyTrio(material), client.proofService);
}

/** Read only: derivation and decryption, no proving. */
export function readKeys(material: ShieldedMaterial): LocalShieldedKeys {
  return LocalShieldedKeys.fromKeys(keyTrio(material));
}
