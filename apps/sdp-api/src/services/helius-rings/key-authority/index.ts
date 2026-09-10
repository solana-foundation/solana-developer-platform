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
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { createRingsKeyCipher } from "@/lib/rings-key-crypto";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { beginDbMaterialRotation, createDbMaterialSource } from "./database";

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

/** A rotation whose staged material is committed once the chain publishes it. */
export interface KeyAuthorityRotation {
  commit(): Promise<void>;
}

/** For authorities with nothing to stage. */
const NO_ROTATION: KeyAuthorityRotation = {
  async commit() {},
};

export interface RotationContext {
  readonly env: Env;
  readonly organizationId: string;
  readonly keyRefs: HeliusRingsKeyRefRepository;
  readonly walletId: string;
}

/**
 * Everything one authority can do. Keeping creation, rotation, and reconciliation
 * together makes the registry exhaustive once rather than maintaining three maps
 * that can drift independently.
 *
 * Adding an id to `RINGS_KEY_AUTHORITIES` without a complete descriptor is a type
 * error. In particular, a new authority must state what rotation means rather
 * than inheriting a silent no-op.
 */
interface AuthorityDescriptor {
  create(context: AuthorityContext): ShieldedMaterialSource;
  beginRotation(context: RotationContext): Promise<KeyAuthorityRotation>;
  commitRotation(context: RotationContext): Promise<void>;
}

const authorities = {
  deterministic: {
    create: ({ env }) => {
      // Still served in production, but only for wallets pinned before the seed
      // authority was closed off. Refusing would brick them without making their
      // keys less public; the migration is what ends that exposure.
      if (env.ENVIRONMENT !== "development") warnLegacySeedWallet();
      warnDeterministicKeyAuthority();
      return createDeterministicMaterialSource({ seed: DETERMINISTIC_KA_SEED });
    },
    // Purely derived material has nothing to stage or commit.
    beginRotation: async () => NO_ROTATION,
    commitRotation: async () => undefined,
  },
  database: {
    create: ({ env, organizationId, keyRefs, mayCreate }) =>
      createDbMaterialSource({
        keyRefs,
        cipher: createRingsKeyCipher(env),
        organizationId,
        mayCreate,
      }),
    beginRotation: async ({ env, organizationId, keyRefs, walletId }) =>
      await beginDbMaterialRotation({
        keyRefs,
        cipher: createRingsKeyCipher(env),
        organizationId,
        walletId,
      }),
    commitRotation: async ({ keyRefs, walletId }) => {
      await keyRefs.commitKeyRefRotation({ walletId });
    },
  },
} satisfies Record<RingsKeyAuthority, AuthorityDescriptor>;

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
 * Stages fresh key material for a wallet, dispatching on the authority it is
 * pinned to, and returns the commit to run once publication is confirmed.
 *
 * Must run before the gateway republishes the identity, because the identity is
 * derived from the new bytes, and only from the re-key path, which has taken an
 * exclusive lock and had the operator confirm the loss. A gateway error leaves
 * it staged: a rejection cannot distinguish "never broadcast" from "landed but
 * confirmation failed", and the next chain read is the safe way to decide.
 */
export async function beginKeyAuthorityRotation(
  context: RotationContext & { readonly keyAuthority: string }
): Promise<KeyAuthorityRotation> {
  return await authorities[requireKnownAuthority(context.keyAuthority)].beginRotation(context);
}

export async function commitKeyAuthorityRotation(
  context: RotationContext & { readonly keyAuthority: string }
): Promise<void> {
  await authorities[requireKnownAuthority(context.keyAuthority)].commitRotation(context);
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
 * deployment with neither Rings cipher setting therefore fails startup rather
 * than quietly minting identities anyone can derive.
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

/** Fails startup before an enabled database authority can accept traffic without a cipher. */
export function assertRingsKeyAuthorityConfiguration(env: Env): void {
  if (!isHeliusRingsEnabled(env)) return;
  if (resolveDefaultKeyAuthority(env) === "database") {
    createRingsKeyCipher(env);
  }
}

const CIPHER_PREFLIGHT_ORG = "rings-key-authority-preflight";
const CIPHER_PREFLIGHT_VALUE = "rings-key-authority-preflight";

/** Exercises the active local/KMS path before the process accepts Rings work. */
export async function verifyRingsKeyAuthorityConfiguration(env: Env): Promise<void> {
  assertRingsKeyAuthorityConfiguration(env);
  if (!isHeliusRingsEnabled(env) || resolveDefaultKeyAuthority(env) !== "database") return;

  const cipher = createRingsKeyCipher(env);
  const ciphertext = await cipher.encrypt(CIPHER_PREFLIGHT_ORG, CIPHER_PREFLIGHT_VALUE);
  const opened = await cipher.decrypt(CIPHER_PREFLIGHT_ORG, ciphertext);
  if (opened !== CIPHER_PREFLIGHT_VALUE) {
    throw new HeliusRingsError("config_error", "Rings key cipher failed its startup round-trip");
  }
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

  async function loadWallet(walletId: string): Promise<HeliusRingsWalletRow> {
    const row = await walletsOf().getWalletById({ organizationId, projectId, id: walletId });
    if (!row) {
      throw new HeliusRingsError(
        "invalid_input",
        "no Rings wallet with that id exists in this project"
      );
    }
    return row;
  }

  return {
    async withMaterial(request: MaterialRequest, use) {
      const wallet = await loadWallet(request.walletId);
      const source = authorities[requireKnownAuthority(wallet.key_authority)].create({
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
