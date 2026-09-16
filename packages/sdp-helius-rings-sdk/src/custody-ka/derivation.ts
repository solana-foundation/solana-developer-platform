import {
  createShieldedMaterialFromDerivationSeed,
  type ShieldedMaterialSource,
} from "../material.js";
import { fetchDerivationSeed, type SignMessage } from "./seed.js";

export interface CustodyMaterialSourceConfig {
  /** Signs raw bytes with the custody key for `owner`; base64 in, base64 out. */
  readonly signMessage: SignMessage;
}

/**
 * A {@link ShieldedMaterialSource} rooted in SDP custody.
 *
 * The owner's custody key signs Zolana's derivation message; that signature is
 * the seed the shielded keys expand from. The custody secret never leaves its
 * provider, and the same key that signs the outer transaction roots the
 * shielded identity — one key, both halves of an operation.
 *
 * Every material use is one custody signing round trip: the seed is fetched
 * fresh, expanded, and zeroed before this returns. Nothing holds it between
 * uses, so the process never retains spend-capable material at rest.
 *
 * `organizationId`, `projectId` and `walletId` on the request are audit context
 * here, not derivation inputs: the seed is a function of the owner key alone.
 * Two rings wallets over one custody wallet therefore converge on one shielded
 * identity, which is what the on-chain registry models — its record PDA is keyed
 * on the owner address and nothing else.
 */
export function createCustodyMaterialSource(
  config: CustodyMaterialSourceConfig
): ShieldedMaterialSource {
  return {
    async withMaterial(request, use) {
      const seed = await fetchDerivationSeed(config.signMessage, request.owner);

      try {
        const material = await createShieldedMaterialFromDerivationSeed({
          owner: request.owner,
          derivationSeed: seed,
        });

        try {
          return await use(material);
        } finally {
          material.destroy();
        }
      } finally {
        seed.fill(0);
      }
    },
  };
}
