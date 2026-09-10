import {
  createShieldedMaterialFromDerivationSeed,
  type ShieldedMaterialSource,
} from "../material.js";
import { fetchDerivationSeed, type SignMessage } from "./seed.js";
import { type SeedCacheConfig, withCachedSeed } from "./seed-cache.js";

export interface CustodyMaterialSourceConfig {
  /** Signs raw bytes with the custody key for `owner`; base64 in, base64 out. */
  readonly signMessage: SignMessage;
  /** Seed cache tuning. `ttlMs: 0` disables caching. */
  readonly cache?: SeedCacheConfig;
}

/**
 * A {@link ShieldedMaterialSource} rooted in SDP custody.
 *
 * The owner's custody key signs Zolana's derivation message; that signature is
 * the seed the shielded keys expand from. The custody secret never leaves its
 * provider, and the same key that signs the outer transaction roots the
 * shielded identity — one key, both halves of an operation.
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
      const seed = await withCachedSeed(
        request.owner,
        () => fetchDerivationSeed(config.signMessage, request.owner),
        config.cache ?? {}
      );

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
        // Our copy, not the cache's; the cache holds and expires its own.
        seed.fill(0);
      }
    },
  };
}
