import { HeliusRingsError, RINGS_KEY_AUTHORITIES, type RingsKeyAuthority } from "@sdp/helius-rings";
import {
  createDeterministicMaterialSource,
  DETERMINISTIC_KA_SEED,
  type MaterialRequest,
  type ShieldedMaterialSource,
  warnDeterministicKeyAuthority,
} from "@sdp/helius-rings-sdk";
import {
  createHeliusRingsKeyRefRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import type { HeliusRingsKeyRefRepository } from "@/db/repositories/helius-rings-key-ref.repository";
import type {
  HeliusRingsWalletRepository,
  HeliusRingsWalletRow,
} from "@/db/repositories/helius-rings-wallet.repository";
import { createRingsKeyCipher } from "@/lib/rings-key-crypto";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { createDbMaterialSource, rotateDbMaterial } from "./database";

/**
 * What an authority needs to serve one request. `mayCreate` is per-call rather
 * than per-authority because it is a property of the wallet's state, not of where
 * its keys live.
 */
export interface AuthorityContext {
  readonly env: Env;
  readonly organizationId: string;
  readonly keyRefs: HeliusRingsKeyRefRepository;
  readonly mayCreate: boolean;
}

type AuthorityFactory = (context: AuthorityContext) => ShieldedMaterialSource;

let warnedLegacySeedWallet = false;

/** Once per process, not once per wallet, so a busy project cannot flood the log. */
function warnLegacySeedWallet(): void {
  if (warnedLegacySeedWallet) return;
  warnedLegacySeedWallet = true;

  getLogger().error(
    "a Rings wallet in this deployment is still pinned to the seed-derived key authority, " +
      "whose keys anyone with the source can derive; migrate it with " +
      "`pnpm -C apps/sdp-api rings:keys:migrate`, which preserves each wallet's identity"
  );
}

/**
 * Every key authority SDP can serve a wallet from.
 *
 * The `satisfies` is the point of writing this as a map: adding an id to
 * `RINGS_KEY_AUTHORITIES` without adding a factory here is a type error, so the
 * set of authorities and the set of implementations cannot drift.
 */
const authorityFactories = {
  deterministic: ({ env }) => {
    // Still served in production, but only for wallets pinned before the seed
    // authority was closed off. Refusing outright would brick them without
    // making their keys any less public; migrating them is what fixes that, so
    // this names the command that does it.
    if (env.ENVIRONMENT !== "development") {
      warnLegacySeedWallet();
    }
    warnDeterministicKeyAuthority();
    return createDeterministicMaterialSource({ seed: DETERMINISTIC_KA_SEED });
  },
  database: ({ env, organizationId, keyRefs, mayCreate }) =>
    createDbMaterialSource({
      keyRefs,
      cipher: createRingsKeyCipher(env),
      organizationId,
      mayCreate,
    }),
} satisfies Record<RingsKeyAuthority, AuthorityFactory>;

type MaterialRotator = (context: RotationContext) => Promise<void>;

export interface RotationContext {
  readonly env: Env;
  readonly organizationId: string;
  readonly keyRefs: HeliusRingsKeyRefRepository;
  readonly walletId: string;
}

/**
 * How each authority rotates a wallet's keys, for the one caller that abandons
 * an identity on purpose.
 *
 * Exhaustive for the same reason as `authorityFactories`: a new authority has to
 * state what rotation means for it rather than inheriting a silent no-op, since
 * "rotation did nothing" is the failure mode that matters here.
 */
const materialRotators = {
  // Material is a pure function of the seed and the wallet's path, so there is
  // nothing to rotate. Re-keying such a wallet republishes the same identity;
  // that was already true before authorities were selectable.
  deterministic: async () => undefined,
  database: async ({ env, organizationId, keyRefs, walletId }) =>
    await rotateDbMaterial({
      keyRefs,
      cipher: createRingsKeyCipher(env),
      organizationId,
      walletId,
    }),
} satisfies Record<RingsKeyAuthority, MaterialRotator>;

const KNOWN_AUTHORITIES: ReadonlySet<string> = new Set(RINGS_KEY_AUTHORITIES);

function requireKnownAuthority(authority: string): RingsKeyAuthority {
  if (!KNOWN_AUTHORITIES.has(authority)) {
    // Unreachable while the column's CHECK holds, but a row written by a newer
    // deployment that knows an authority this one does not would otherwise fail
    // as an undefined-is-not-a-function deep inside the SDK.
    throw new HeliusRingsError(
      "config_error",
      "this Rings wallet is pinned to a key authority this deployment does not support"
    );
  }
  return authority as RingsKeyAuthority;
}

/**
 * Discards a wallet's current key material so the next read generates fresh
 * keys, dispatching on the authority the wallet is pinned to.
 *
 * Must run before the gateway republishes the identity, and only from the re-key
 * path, which has taken an exclusive lock and had the operator confirm the loss.
 */
export async function rotateKeyAuthorityMaterial(
  context: RotationContext & { readonly keyAuthority: string }
): Promise<void> {
  await materialRotators[requireKnownAuthority(context.keyAuthority)](context);
}

/**
 * Authorities a deployment may pin new wallets to. `deterministic` derives from a
 * seed committed to this repository, so outside development it is not a custody
 * option at all — anyone with the source could spend those notes.
 */
function selectableAuthorities(env: Env): readonly RingsKeyAuthority[] {
  return env.ENVIRONMENT === "development"
    ? RINGS_KEY_AUTHORITIES
    : RINGS_KEY_AUTHORITIES.filter((authority) => authority !== "deterministic");
}

/**
 * The authority new wallets are pinned to.
 *
 * The default differs by environment on purpose. Development keeps the
 * seed-derived authority so local work and tests need no key configured, while
 * production defaults to stored keys and refuses the seed outright. A production
 * deployment with no `RINGS_KEY_ENCRYPTION_KEY` therefore fails to provision
 * rather than quietly minting identities anyone can derive.
 */
export function resolveDefaultKeyAuthority(env: Env): RingsKeyAuthority {
  const selectable = selectableAuthorities(env);
  const configured = env.HELIUS_RINGS_KEY_AUTHORITY?.trim();
  if (!configured) {
    return env.ENVIRONMENT === "development" ? "deterministic" : "database";
  }
  if (!selectable.includes(configured as RingsKeyAuthority)) {
    throw new HeliusRingsError(
      "config_error",
      KNOWN_AUTHORITIES.has(configured)
        ? `HELIUS_RINGS_KEY_AUTHORITY cannot be '${configured}' outside development; use one of ${selectable.join(", ")}`
        : `HELIUS_RINGS_KEY_AUTHORITY must be one of ${selectable.join(", ")}`
    );
  }
  return configured as RingsKeyAuthority;
}

export interface RoutingMaterialSourceConfig {
  readonly env: Env;
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * Resolved on first use rather than up front, so constructing a gateway needs
   * no database handle. Health probes build one and never ask for material.
   * Also the test seam.
   */
  readonly wallets?: () => HeliusRingsWalletRepository;
  readonly keyRefs?: () => HeliusRingsKeyRefRepository;
}

/**
 * Routes each material request to the authority its wallet is pinned to.
 *
 * Per-request rather than per-gateway because one gateway serves more than one
 * wallet: a private transfer loads the recipient's material to lift its shielded
 * address, and sender and recipient can sit on different authorities. Since
 * `MaterialRequest` names the wallet, the routing decision belongs here.
 *
 * The same lookup answers whether a call may seal new keys. Only a wallet that
 * has not published an identity is legitimately missing material, so a request
 * for an already-provisioned wallet is read-only. Without that, lifting a
 * recipient's address would generate and permanently seal keys for the recipient
 * as a side effect of someone else's transfer.
 */
export function createRoutingMaterialSource(
  config: RoutingMaterialSourceConfig
): ShieldedMaterialSource {
  const { env, organizationId, projectId } = config;
  const walletsOf = config.wallets ?? (() => createHeliusRingsWalletRepository(env));
  const keyRefsOf = config.keyRefs ?? (() => createHeliusRingsKeyRefRepository(env));
  // One gateway serves one request, so this is short-lived by construction. It
  // exists so a spend that touches two wallets does not re-read either.
  const cache = new Map<string, Promise<HeliusRingsWalletRow>>();

  function loadWallet(walletId: string): Promise<HeliusRingsWalletRow> {
    const cached = cache.get(walletId);
    if (cached) return cached;

    const pending = walletsOf()
      .getWalletById({ organizationId, projectId, id: walletId })
      .then((row) => {
        if (!row) {
          throw new HeliusRingsError(
            "invalid_input",
            "no Rings wallet with that id exists in this project"
          );
        }
        return row;
      })
      .catch((error: unknown) => {
        // A failed read must not be remembered, or every later wallet in the
        // same request inherits the failure.
        cache.delete(walletId);
        throw error;
      });
    cache.set(walletId, pending);
    return pending;
  }

  return {
    async withMaterial(request: MaterialRequest, use) {
      const wallet = await loadWallet(request.walletId);
      const source = authorityFactories[requireKnownAuthority(wallet.key_authority)]({
        env,
        organizationId,
        keyRefs: keyRefsOf(),
        // No published identity means provisioning has not finished, which is the
        // only point at which a wallet's keys legitimately do not exist yet.
        mayCreate: wallet.shielded_address === null,
      });

      return await source.withMaterial(request, use);
    },
  };
}
